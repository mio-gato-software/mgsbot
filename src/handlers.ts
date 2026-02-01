import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import {
	analyzeYouTube,
	describeImage,
	evaluateMemory,
	generateResponse,
	textToSpeech,
	transcribeAudio,
} from "./ai.ts";
import {
	addLongTermMemories,
	addMemberFacts,
	addMessageToShortTerm,
	getRelevantMemories,
	loadLongTerm,
	loadMemberMemory,
	loadShortTerm,
	saveLongTerm,
} from "./memory.ts";
import { buildContents, buildSystemPrompt } from "./prompt.ts";
import type { ConversationMessage } from "./types.ts";

const SILENCE_TOKEN = "[SILENCE]";
const EVAL_EVERY_N_MESSAGES = 5;
const ALLOWED_GROUP_ID = Number(process.env.ALLOWED_GROUP_ID);
const OWNER_USER_ID = Number(process.env.OWNER_USER_ID);
const isDev = process.env.NODE_ENV === "development";

function getUserDisplayName(ctx: Context): string {
	const user = ctx.from;
	if (!user) return "Unknown";
	if (user.first_name && user.last_name)
		return `${user.first_name} ${user.last_name}`;
	return user.first_name ?? user.username ?? "Unknown";
}

function isGroupChat(ctx: Context): boolean {
	const type = ctx.chat?.type;
	return type === "group" || type === "supergroup";
}

function isBotMentionedOrRepliedTo(ctx: Context, botId: number): boolean {
	// Check if replied to the bot
	if (ctx.message?.reply_to_message?.from?.id === botId) return true;

	// Check if bot is mentioned in entities
	const entities = ctx.message?.entities ?? [];
	const text = ctx.message?.text ?? "";
	for (const entity of entities) {
		if (entity.type === "mention") {
			const mention = text.slice(entity.offset, entity.offset + entity.length);
			if (mention === `@${ctx.me?.username}`) return true;
		}
	}

	return false;
}

async function processConversation(
	ctx: Context,
	userContent: string,
	userName: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const botInfo = ctx.me;

	// Load memories
	const shortTerm = await loadShortTerm(chatId);
	const longTermEntries = await loadLongTerm();
	const relevantMemories = getRelevantMemories(longTermEntries);
	const memberMemory = await loadMemberMemory();

	// Save updated lastAccessed times
	if (relevantMemories.length > 0) {
		await saveLongTerm(longTermEntries);
	}

	// Add user message to short-term
	const userMessage: ConversationMessage = {
		role: "user",
		name: userName,
		content: userContent,
		timestamp: Date.now(),
	};
	await addMessageToShortTerm(shortTerm, userMessage);

	// Build prompt
	const systemPrompt = await buildSystemPrompt(
		relevantMemories,
		shortTerm.previousSummary,
		memberMemory,
	);
	const contents = buildContents(shortTerm);

	// In groups, add instruction for selective response
	let effectiveSystemPrompt = systemPrompt;
	const willDefinitelyRespond =
		!isGroupChat(ctx) || isBotMentionedOrRepliedTo(ctx, botInfo.id);
	if (!willDefinitelyRespond) {
		effectiveSystemPrompt += `\n\n## Group response rule\nThis is a group chat and you were NOT directly mentioned or replied to. You MUST respond with exactly ${SILENCE_TOKEN} unless the message is clearly directed at you by context (e.g. someone is talking to you or about you). Do NOT respond just because you find the topic interesting or have an opinion. When in doubt, choose ${SILENCE_TOKEN}.`;
	}

	// Show typing indicator only when we know the bot will respond
	if (willDefinitelyRespond) {
		await ctx.replyWithChatAction("typing");
	}

	// Generate response
	const responseText = await generateResponse(effectiveSystemPrompt, contents);

	// Check for silence
	if (responseText.trim() === SILENCE_TOKEN) {
		return;
	}

	// Show typing now if we didn't before (bot decided to respond voluntarily)
	if (!willDefinitelyRespond) {
		await ctx.replyWithChatAction("typing");
	}

	// Save bot response to short-term
	const botMessage: ConversationMessage = {
		role: "model",
		content: responseText,
		timestamp: Date.now(),
	};
	await addMessageToShortTerm(shortTerm, botMessage);

	// Reply (check for TTS marker first)
	const replyOptions = {
		reply_to_message_id: isGroupChat(ctx) ? ctx.message?.message_id : undefined,
	};

	const TTS_REGEX = /\[TTS\]([\s\S]+?)\[\/TTS\]/;
	const ttsMatch = responseText.match(TTS_REGEX);

	if (isDev)
		console.log(
			"[TTS] Checking for marker:",
			ttsMatch ? `found "${ttsMatch[1]}"` : "not found",
		);

	if (ttsMatch) {
		const ttsText = ttsMatch[1].trim();

		// Generate and send voice note only
		try {
			if (isDev) console.log("[TTS] Generating speech for:", ttsText);
			const audioPath = await textToSpeech(ttsText);
			if (isDev) console.log("[TTS] Audio saved to:", audioPath);
			await ctx.replyWithVoice(new InputFile(audioPath), replyOptions);
		} catch (error) {
			console.error("[TTS] Error generating speech:", error);
			// Fallback: send the TTS text as plain text
			try {
				await ctx.reply(ttsText, replyOptions);
			} catch {
				// ignore fallback failure
			}
		}
	} else {
		try {
			await ctx.reply(responseText, {
				...replyOptions,
				parse_mode: "Markdown",
			});
		} catch {
			await ctx.reply(responseText, replyOptions);
		}
	}

	// Trigger long-term memory evaluation every N messages
	if (shortTerm.messageCountSinceEval >= EVAL_EVERY_N_MESSAGES) {
		shortTerm.messageCountSinceEval = 0;
		// Run evaluation in background (don't await)
		triggerMemoryEvaluation(shortTerm.messages).catch(console.error);
	}
}

async function triggerMemoryEvaluation(
	messages: ConversationMessage[],
): Promise<void> {
	const recentText = messages
		.slice(-10)
		.map(
			(m) => `${m.role === "user" ? (m.name ?? "User") : "Bot"}: ${m.content}`,
		)
		.join("\n");

	const evaluation = await evaluateMemory(recentText);

	if (evaluation.save && evaluation.memories.length > 0) {
		await addLongTermMemories(evaluation.memories);
	}

	if (evaluation.memberFacts.length > 0) {
		await addMemberFacts(evaluation.memberFacts);
	}
}

async function downloadAndTranscribe(
	ctx: Context,
	botToken: string,
	mimeType: string,
	fileExtension: string,
	prefix: string,
): Promise<string> {
	const file = await ctx.getFile();
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	if (isDev) console.log("[downloadAndTranscribe] Downloading from:", url);

	const response = await fetch(url);
	if (!response.ok) {
		console.error(
			"[downloadAndTranscribe] Download failed:",
			response.status,
			response.statusText,
		);
		return "[transcription failed]";
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const filePath = `./audios/${prefix}_${ctx.message?.message_id}.${fileExtension}`;
	await Bun.write(filePath, buffer);
	if (isDev)
		console.log(
			"[downloadAndTranscribe] Saved to:",
			filePath,
			`(${buffer.length} bytes)`,
		);

	const transcription = await transcribeAudio(filePath, mimeType);
	if (isDev)
		console.log(
			"[downloadAndTranscribe] Transcription:",
			transcription.slice(0, 200),
		);
	return transcription;
}

async function downloadImage(
	ctx: Context,
	botToken: string,
): Promise<{ filePath: string; mimeType: string }> {
	const photos = ctx.message?.photo;
	if (!photos) throw new Error("No photo in message");
	// Telegram sends multiple sizes; pick the largest
	const photo = photos[photos.length - 1];
	const file = await ctx.api.getFile(photo.file_id);
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	if (isDev) console.log("[downloadImage] Downloading from:", url);

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	const ext = file.file_path?.split(".").pop() ?? "jpg";
	const mimeType = ext === "png" ? "image/png" : "image/jpeg";
	const filePath = `./audios/photo_${ctx.message?.message_id}.${ext}`;
	const buffer = Buffer.from(await response.arrayBuffer());
	await Bun.write(filePath, buffer);
	if (isDev)
		console.log(
			"[downloadImage] Saved to:",
			filePath,
			`(${buffer.length} bytes)`,
		);

	return { filePath, mimeType };
}

const YOUTUBE_REGEX =
	/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]+)/;

function extractYouTubeUrl(
	ctx: Context,
): { url: string; remainingText: string } | null {
	const text = ctx.message?.text ?? "";
	const entities = ctx.message?.entities ?? [];

	// Check URL entities first
	for (const entity of entities) {
		if (entity.type === "url" || entity.type === "text_link") {
			const entityUrl =
				entity.type === "text_link"
					? (entity.url ?? "")
					: text.slice(entity.offset, entity.offset + entity.length);
			if (YOUTUBE_REGEX.test(entityUrl)) {
				const remaining = (
					text.slice(0, entity.offset) +
					text.slice(entity.offset + entity.length)
				).trim();
				return { url: entityUrl, remainingText: remaining };
			}
		}
	}

	// Regex fallback
	const match = text.match(YOUTUBE_REGEX);
	if (match) {
		const remaining = text.replace(match[0], "").trim();
		return { url: match[0], remainingText: remaining };
	}

	return null;
}

export function registerHandlers(bot: Bot): void {
	const botToken = bot.token;

	// Security: only allow the owner (DMs) and the permitted group
	bot.use(async (ctx, next) => {
		const chatId = ctx.chat?.id;
		if (isGroupChat(ctx)) {
			if (chatId !== ALLOWED_GROUP_ID) {
				console.log(`[guard] Unauthorized group ${chatId}, leaving...`);
				if (chatId) {
					await ctx.api
						.leaveChat(chatId)
						.catch((e) => console.error("[guard] Failed to leave:", e));
				}
				return;
			}
		} else if (ctx.from?.id !== OWNER_USER_ID) {
			console.log(
				`[guard] Unauthorized DM from user ${ctx.from?.id}, ignoring`,
			);
			return;
		}
		await next();
	});

	// Voice messages
	bot.on("message:voice", async (ctx) => {
		try {
			const transcription = await downloadAndTranscribe(
				ctx,
				botToken,
				"audio/ogg",
				"ogg",
				"voice",
			);
			const userName = getUserDisplayName(ctx);
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversation(ctx, content, userName);
		} catch (error) {
			console.error("[voice handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Voice handler error: ${error}`).catch(() => {});
		}
	});

	// Audio files
	bot.on("message:audio", async (ctx) => {
		try {
			const ext = ctx.message.audio.mime_type?.split("/")[1] ?? "mp3";
			const mimeType = ctx.message.audio.mime_type ?? "audio/mp3";
			const transcription = await downloadAndTranscribe(
				ctx,
				botToken,
				mimeType,
				ext,
				"audio",
			);
			const userName = getUserDisplayName(ctx);
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversation(ctx, content, userName);
		} catch (error) {
			console.error("[audio handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Audio handler error: ${error}`).catch(() => {});
		}
	});

	// Photos
	bot.on("message:photo", async (ctx) => {
		try {
			const { filePath, mimeType } = await downloadImage(ctx, botToken);
			const caption = ctx.message.caption;
			const description = await describeImage(filePath, mimeType, caption);
			const userName = getUserDisplayName(ctx);
			const content = caption
				? `[Image from ${userName}, caption: "${caption}"]: ${description}`
				: `[Image from ${userName}]: ${description}`;
			await processConversation(ctx, content, userName);
		} catch (error) {
			console.error("[photo handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Photo handler error: ${error}`).catch(() => {});
		}
	});

	// Text messages (catch-all)
	bot.on("message", async (ctx) => {
		const text = ctx.message.text;
		if (!text) return;
		const userName = getUserDisplayName(ctx);

		const yt = extractYouTubeUrl(ctx);
		if (yt) {
			const analysis = await analyzeYouTube(
				yt.url,
				yt.remainingText || undefined,
			);
			const content = yt.remainingText
				? `[YouTube video from ${userName}, message: "${yt.remainingText}"]: ${analysis}`
				: `[YouTube video from ${userName}]: ${analysis}`;
			await processConversation(ctx, content, userName);
			return;
		}

		await processConversation(ctx, text, userName);
	});
}
