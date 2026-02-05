import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import {
	analyzeYouTube,
	describeImage,
	evaluateMemory,
	generateImage,
	generateResponse,
	textToSpeech,
	transcribeAudio,
} from "./ai.ts";
import { getBrendyBasePath } from "./brendy-appearance.ts";
import {
	addLongTermMemories,
	addMemberFacts,
	addMessageToShortTerm,
	getRelevantMemories,
	loadLongTerm,
	loadMemberMemory,
	loadShortTerm,
	saveLongTerm,
	saveShortTerm,
} from "./memory.ts";
import {
	buildMessages,
	buildSystemPrompt,
	isSimpleAssistantMode,
} from "./prompt.ts";
import type { ConversationMessage, ShortTermMemory } from "./types.ts";

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

/**
 * Type of mention detected in a message
 * - "none": Bot not mentioned at all
 * - "reply": User replied to bot's message (always respond)
 * - "tag": User @mentioned the bot (always respond)
 * - "name": User mentioned bot's name (AI decides if addressed or just mentioned)
 */
export type MentionType = "none" | "reply" | "tag" | "name";

function detectMentionType(ctx: Context, botId: number): MentionType {
	// Check if replied to the bot - always respond
	if (ctx.message?.reply_to_message?.from?.id === botId) return "reply";

	const entities = ctx.message?.entities ?? [];
	const text = ctx.message?.text ?? ctx.message?.caption ?? "";

	// Check if @mentioned - always respond
	for (const entity of entities) {
		if (entity.type === "mention") {
			const mention = text.slice(entity.offset, entity.offset + entity.length);
			if (mention === `@${ctx.me?.username}`) return "tag";
		}
	}

	// Check if called by name - AI decides if addressed or just mentioned
	if (/\bbrendy\b/i.test(text)) return "name";

	return "none";
}

function getTodayDateRD(): string {
	return new Date().toLocaleDateString("en-CA", {
		timeZone: "America/Santo_Domingo",
	});
}

const IMAGE_EARLIEST_HOUR = 8;
const IMAGE_LATEST_HOUR = 23;

function generateRandomTargetTime(): string {
	const randomHour =
		IMAGE_EARLIEST_HOUR +
		Math.floor(Math.random() * (IMAGE_LATEST_HOUR - IMAGE_EARLIEST_HOUR + 1));
	const randomMinute = Math.floor(Math.random() * 60);

	const rdDate = getTodayDateRD();
	const [year, month, day] = rdDate.split("-").map(Number);

	const target = new Date(year, month - 1, day, randomHour, randomMinute, 0, 0);
	return target.toISOString();
}

function shouldGenerateImageNow(shortTerm: ShortTermMemory): boolean {
	const todayRD = getTodayDateRD();

	// Already generated today
	if (shortTerm.lastImageDate === todayRD) return false;

	// New day or missing target - generate random target time
	if (shortTerm.imageTargetDate !== todayRD || !shortTerm.imageTargetTime) {
		shortTerm.imageTargetTime = generateRandomTargetTime();
		shortTerm.imageTargetDate = todayRD;
		if (isDev) {
			console.log(
				"[image] New target time generated:",
				shortTerm.imageTargetTime,
			);
		}
	}

	// Check if current time passed target
	const now = new Date();
	const target = new Date(shortTerm.imageTargetTime);
	return now >= target;
}

const IMAGE_MARKER_REGEX = /\[IMAGE:\s*([^\]]+)\]/;
const REACTION_MARKER_REGEX = /^\[REACT:([^\]]+)\]$/;
const SILENCE_MARKER = "[SILENCE]";

async function processConversation(
	ctx: Context,
	userContent: string,
	userName: string,
	mentionType: MentionType = "none",
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	// Load short-term memory (always needed for conversation history)
	const shortTerm = await loadShortTerm(chatId);

	// Add user message to short-term
	const userMessage: ConversationMessage = {
		role: "user",
		name: userName,
		content: userContent,
		timestamp: Date.now(),
	};
	await addMessageToShortTerm(shortTerm, userMessage);

	// Build prompt and messages
	let systemPrompt: string;
	let shouldGenImage = false;

	if (isSimpleAssistantMode) {
		// Simple mode: skip memory loading, use minimal prompt
		systemPrompt = await buildSystemPrompt([], "", {}, false);
	} else {
		// Full mode: load all memories
		const longTermEntries = await loadLongTerm();
		const relevantMemories = getRelevantMemories(longTermEntries, userContent);
		const memberMemory = await loadMemberMemory();

		// Save updated lastAccessed times
		if (relevantMemories.length > 0) {
			await saveLongTerm(longTermEntries);
		}

		shouldGenImage = shouldGenerateImageNow(shortTerm);
		systemPrompt = await buildSystemPrompt(
			relevantMemories,
			shortTerm.previousSummary,
			memberMemory,
			shouldGenImage,
			isGroupChat(ctx) ? mentionType : undefined,
		);
	}
	const messages = buildMessages(shortTerm);

	// Show typing indicator
	await ctx.replyWithChatAction("typing");

	// Generate response
	let responseText = await generateResponse(systemPrompt, messages);

	// Check for [SILENCE] marker - bot chose not to respond
	if (responseText.trim() === SILENCE_MARKER) {
		if (isDev) console.log("[response] Bot chose to stay silent");
		return;
	}

	// Check for [REACT:emoji] marker - bot wants to react with emoji instead of text
	const reactionMatch = responseText.trim().match(REACTION_MARKER_REGEX);
	if (reactionMatch) {
		const emoji = reactionMatch[1].trim();
		if (isDev) console.log("[response] Bot reacting with emoji:", emoji);
		try {
			await ctx.react(emoji);
		} catch (error) {
			console.error("[reaction] Error reacting:", error);
		}
		return;
	}

	// Reply options
	const replyOptions = {
		reply_to_message_id: isGroupChat(ctx) ? ctx.message?.message_id : undefined,
	};

	// Check for image marker and generate image (only if allowed today)
	const imageMatch = shouldGenImage
		? responseText.match(IMAGE_MARKER_REGEX)
		: null;
	if (!shouldGenImage) {
		responseText = responseText.replace(IMAGE_MARKER_REGEX, "").trim();
	}
	let imageSent = false;

	if (imageMatch) {
		const extractedPrompt = imageMatch[1].trim();
		responseText = responseText.replace(IMAGE_MARKER_REGEX, "").trim();
		const basePath = getBrendyBasePath();

		if (basePath) {
			try {
				await ctx.replyWithChatAction("upload_photo");
				if (isDev)
					console.log("[image] Prompt:", extractedPrompt.slice(0, 300));
				const imageBuffer = await generateImage(extractedPrompt, basePath);

				await ctx.replyWithPhoto(new InputFile(imageBuffer, "brendy.png"), {
					caption: responseText || undefined,
					...replyOptions,
				});
				imageSent = true;

				shortTerm.lastImageDate = getTodayDateRD();
				await saveShortTerm(shortTerm);
			} catch (error) {
				console.error("[image] Error generating image:", error);
				// Fall through to normal text reply
			}
		} else {
			console.warn("[image] No base image found, skipping image generation");
		}
	}

	// Save bot response to short-term (only if non-empty)
	if (responseText.trim()) {
		const botMessage: ConversationMessage = {
			role: "model",
			content: responseText,
			timestamp: Date.now(),
		};
		await addMessageToShortTerm(shortTerm, botMessage);
	}

	// Send text reply if image wasn't sent (or had no caption)
	if (!imageSent) {
		// TTS is disabled in simple assistant mode
		const TTS_REGEX = /\[TTS\]([\s\S]+?)\[\/TTS\]/;
		const ttsMatch = isSimpleAssistantMode
			? null
			: responseText.match(TTS_REGEX);

		if (isDev)
			console.log(
				"[TTS] Checking for marker:",
				ttsMatch ? `found "${ttsMatch[1]}"` : "not found",
			);

		if (ttsMatch) {
			const ttsText = ttsMatch[1].trim();

			try {
				if (isDev) console.log("[TTS] Generating speech for:", ttsText);
				const audioPath = await textToSpeech(ttsText);
				if (isDev) console.log("[TTS] Audio saved to:", audioPath);
				await ctx.replyWithVoice(new InputFile(audioPath), replyOptions);
			} catch (error) {
				console.error("[TTS] Error generating speech:", error);
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
	}

	// Trigger long-term memory evaluation every N messages (disabled in simple mode)
	if (
		!isSimpleAssistantMode &&
		shortTerm.messageCountSinceEval >= EVAL_EVERY_N_MESSAGES
	) {
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

	// Load existing context to avoid duplicates
	const [longTermEntries, memberMemory] = await Promise.all([
		loadLongTerm(),
		loadMemberMemory(),
	]);

	const existingContext = {
		memories: longTermEntries.map((e) => ({
			content: e.content,
			importance: e.importance,
		})),
		memberFacts: Object.fromEntries(
			Object.entries(memberMemory).map(([member, facts]) => [
				member,
				facts.map((f) => f.key),
			]),
		),
	};

	const evaluation = await evaluateMemory(recentText, existingContext);

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

	// Voice messages (disabled in simple assistant mode)
	bot.on("message:voice", async (ctx) => {
		if (isSimpleAssistantMode) return;
		const mentionType = detectMentionType(ctx, ctx.me.id);
		if (isGroupChat(ctx) && mentionType === "none") return;
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
			await processConversation(ctx, content, userName, mentionType);
		} catch (error) {
			console.error("[voice handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Voice handler error: ${error}`).catch(() => {});
		}
	});

	// Audio files (disabled in simple assistant mode)
	bot.on("message:audio", async (ctx) => {
		if (isSimpleAssistantMode) return;
		const mentionType = detectMentionType(ctx, ctx.me.id);
		if (isGroupChat(ctx) && mentionType === "none") return;
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
			await processConversation(ctx, content, userName, mentionType);
		} catch (error) {
			console.error("[audio handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Audio handler error: ${error}`).catch(() => {});
		}
	});

	// Photos (disabled in simple assistant mode)
	bot.on("message:photo", async (ctx) => {
		if (isSimpleAssistantMode) return;
		const mentionType = detectMentionType(ctx, ctx.me.id);
		if (isGroupChat(ctx) && mentionType === "none") return;
		try {
			const { filePath, mimeType } = await downloadImage(ctx, botToken);
			const caption = ctx.message.caption;
			const description = await describeImage(filePath, mimeType, caption);
			const userName = getUserDisplayName(ctx);
			const content = caption
				? `[Image from ${userName}, caption: "${caption}"]: ${description}`
				: `[Image from ${userName}]: ${description}`;
			await processConversation(ctx, content, userName, mentionType);
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
		const mentionType = detectMentionType(ctx, ctx.me.id);

		// YouTube analysis disabled in simple assistant mode
		const yt = isSimpleAssistantMode ? null : extractYouTubeUrl(ctx);
		if (yt) {
			if (isGroupChat(ctx) && mentionType === "none") return;
			const analysis = await analyzeYouTube(
				yt.url,
				yt.remainingText || undefined,
			);
			const content = yt.remainingText
				? `[YouTube video from ${userName}, message: "${yt.remainingText}"]: ${analysis}`
				: `[YouTube video from ${userName}]: ${analysis}`;
			await processConversation(ctx, content, userName, mentionType);
			return;
		}

		// In groups, only respond when mentioned
		if (isGroupChat(ctx) && mentionType === "none") return;

		await processConversation(ctx, text, userName, mentionType);
	});
}
