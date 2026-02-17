import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import {
	analyzeYouTube,
	describeImage,
	evaluateConversationChunk,
	generateImage,
	generateResponse,
	isImageGenAvailable,
	textToSpeech,
	transcribeAudio,
} from "./ai.ts";
import { getBrendyBasePath } from "./brendy-appearance.ts";
import { generateEmbedding } from "./embeddings.ts";
import { registerIdentity, resolveCanonicalName } from "./identities.ts";
import {
	addEpisode,
	addMessageToSensory,
	addSemanticFacts,
	decayConfidence,
	getFactsForSubjects,
	getQueryEmbedding,
	getRelevantEpisodes,
	getRelevantFacts,
	hasSignificantContent,
	loadSemanticStore,
	loadSensory,
	saveSensory,
} from "./memory.ts";
import {
	buildMessages,
	buildSystemPrompt,
	isSimpleAssistantMode,
} from "./prompt.ts";
import { getChatProviderInfo, switchChatProvider } from "./providers/index.ts";
import type {
	ConversationMessage,
	SemanticFact,
	SensoryBuffer,
} from "./types.ts";

const ALLOWED_GROUP_ID = Number(process.env.ALLOWED_GROUP_ID);
const OWNER_USER_ID = Number(process.env.OWNER_USER_ID);
const isDev = process.env.NODE_ENV === "development";

let botOff = false;

const enableSleepSchedule = process.env.ENABLE_SLEEP_SCHEDULE !== "false";

function isSleepingHour(): boolean {
	if (!enableSleepSchedule) return false;
	const now = new Date(
		new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }),
	);
	const hour = now.getHours();
	const minute = now.getMinutes();
	// 11:30 PM (23:30) to 6:00 AM
	return hour < 6 || (hour === 23 && minute >= 30);
}

function getUserInfo(ctx: Context): {
	name: string;
	userId: number | undefined;
	username: string | undefined;
} {
	const user = ctx.from;
	if (!user) return { name: "Unknown", userId: undefined, username: undefined };
	const name =
		user.first_name && user.last_name
			? `${user.first_name} ${user.last_name}`
			: (user.first_name ?? user.username ?? "Unknown");
	return { name, userId: user.id, username: user.username };
}

function getUserDisplayName(ctx: Context): string {
	return getUserInfo(ctx).name;
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

function getWeekStartRD(): string {
	const rdDate = getTodayDateRD();
	const [year, month, day] = rdDate.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ...6=Sat
	const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
	date.setDate(date.getDate() + mondayOffset);
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function generateRandomWeeklyTargetTime(): string {
	const rdDate = getTodayDateRD();
	const [year, month, day] = rdDate.split("-").map(Number);
	const today = new Date(year, month - 1, day);
	const todayDayOfWeek = today.getDay();

	// Days remaining in the week (Mon–Sun): Sun=0 left, Mon=6, Tue=5, ...Sat=1
	const daysLeftInWeek = todayDayOfWeek === 0 ? 0 : 7 - todayDayOfWeek;

	// Pick a random day from today through end of week
	const randomDayOffset = Math.floor(Math.random() * (daysLeftInWeek + 1));
	const targetDate = new Date(year, month - 1, day + randomDayOffset);

	const randomHour =
		IMAGE_EARLIEST_HOUR +
		Math.floor(Math.random() * (IMAGE_LATEST_HOUR - IMAGE_EARLIEST_HOUR + 1));
	const randomMinute = Math.floor(Math.random() * 60);
	targetDate.setHours(randomHour, randomMinute, 0, 0);

	return targetDate.toISOString();
}

function shouldGenerateImageNow(buffer: SensoryBuffer): boolean {
	if (!isImageGenAvailable()) return false;

	const currentWeek = getWeekStartRD();

	// Already generated this week
	if (buffer.lastImageDate === currentWeek) return false;

	// New week or missing target — pick a random day+time this week
	if (buffer.imageTargetDate !== currentWeek || !buffer.imageTargetTime) {
		buffer.imageTargetTime = generateRandomWeeklyTargetTime();
		buffer.imageTargetDate = currentWeek;
		if (isDev) {
			console.log(
				"[image] New weekly target generated:",
				buffer.imageTargetTime,
			);
		}
	}

	// Check if current time passed target
	const now = new Date();
	const target = new Date(buffer.imageTargetTime);
	return now >= target;
}

const IMAGE_MARKER_REGEX = /\[IMAGE:\s*([^\]]+)\]/;
const REACTION_MARKER_REGEX = /\[REACT:\s*([^\]]+)\]/;
const SILENCE_MARKER = "[SILENCE]";

async function processConversation(
	ctx: Context,
	userContent: string,
	userName: string,
	mentionType: MentionType = "none",
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	if (botOff || (isGroupChat(ctx) && isSleepingHour())) {
		try {
			await ctx.react("😴");
		} catch (error) {
			if (isDev) console.error("[off] Error reacting:", error);
		}
		return;
	}

	// Register identity for this user
	const { userId, username } = getUserInfo(ctx);
	if (userId) {
		await registerIdentity(userId, userName, username);
	}

	// Load sensory buffer
	const buffer = await loadSensory(chatId);

	// Add user message to sensory buffer
	const userMessage: ConversationMessage = {
		role: "user",
		name: userName,
		userId,
		content: userContent,
		timestamp: Date.now(),
	};
	const overflow = await addMessageToSensory(buffer, userMessage);

	// Promote overflow to memory in background
	if (overflow) {
		promoteToMemory(chatId, overflow).catch(console.error);
	}

	// Build prompt and messages
	let systemPrompt: string;
	let shouldGenImage = false;

	if (isSimpleAssistantMode) {
		systemPrompt = await buildSystemPrompt([], [], false);
	} else {
		// Generate query embedding for retrieval
		const { embedding: queryEmbedding, text: queryText } =
			await getQueryEmbedding(buffer.messages);

		// Retrieve relevant episodes and facts
		const [episodes, facts] = await Promise.all([
			getRelevantEpisodes(chatId, queryEmbedding, queryText),
			getRelevantFacts(queryEmbedding, { queryText }),
		]);

		// Also get facts for active participants (canonicalized)
		const rawActiveNames = [
			...new Set(
				buffer.messages.map((m) => m.name).filter((n): n is string => !!n),
			),
		];
		const activeNames = await Promise.all(
			rawActiveNames.map((n) => resolveCanonicalName(n)),
		).then((names) => [...new Set(names)]);
		const participantFacts =
			activeNames.length > 0 ? await getFactsForSubjects(activeNames) : [];

		// Merge and deduplicate facts
		const allFactIds = new Set(facts.map((f) => f.id));
		const mergedFacts = [...facts];
		for (const pf of participantFacts) {
			if (!allFactIds.has(pf.id)) {
				mergedFacts.push(pf);
				allFactIds.add(pf.id);
			}
		}

		shouldGenImage = shouldGenerateImageNow(buffer);
		systemPrompt = await buildSystemPrompt(
			episodes,
			mergedFacts,
			shouldGenImage,
			isGroupChat(ctx) ? mentionType : undefined,
			activeNames,
		);
	}
	const messages = buildMessages(buffer);

	// Show typing indicator
	await ctx.replyWithChatAction("typing");

	// Generate response
	let responseText = await generateResponse(systemPrompt, messages);

	// Guard against empty responses (model returned 0 tokens)
	if (!responseText.trim()) {
		if (isDev) console.log("[response] Empty response from model, skipping");
		return;
	}

	// Check for [SILENCE] marker - bot chose not to respond
	if (responseText.trim() === SILENCE_MARKER) {
		if (isDev) console.log("[response] Bot chose to stay silent");
		return;
	}

	// Handle [SILENCE] mixed with text - send the text part, strip the marker
	if (responseText.includes(SILENCE_MARKER)) {
		responseText = responseText.replace(SILENCE_MARKER, "").trim();
		if (isDev)
			console.log(
				"[response] Stripped [SILENCE] marker, remaining text:",
				responseText,
			);
		if (!responseText) return;
	}

	// Check for [REACT:emoji] marker - bot wants to react with emoji instead of text
	const reactionMatch = responseText.match(REACTION_MARKER_REGEX);
	if (reactionMatch) {
		const emoji = reactionMatch[1].trim();
		if (isDev) console.log("[response] Bot reacting with emoji:", emoji);
		try {
			await ctx.react(emoji);
		} catch (error) {
			console.error("[reaction] Error reacting:", error);
		}
		// Strip the marker and any surrounding backticks; if no remaining text, just react
		responseText = responseText
			.replace(REACTION_MARKER_REGEX, "")
			.replace(/`/g, "")
			.trim();
		if (!responseText) return;
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

				buffer.lastImageDate = getWeekStartRD();
				await saveSensory(buffer);
			} catch (error) {
				console.error("[image] Error generating image:", error);
				// Fall through to normal text reply
			}
		} else {
			console.warn("[image] No base image found, skipping image generation");
		}
	}

	// Save bot response to sensory buffer (only if non-empty)
	if (responseText.trim()) {
		const botMessage: ConversationMessage = {
			role: "model",
			content: responseText,
			timestamp: Date.now(),
		};
		const botOverflow = await addMessageToSensory(buffer, botMessage);

		// Promote bot overflow too
		if (botOverflow) {
			promoteToMemory(chatId, botOverflow).catch(console.error);
		}
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
}

async function promoteToMemory(
	chatId: number,
	overflow: ConversationMessage[],
): Promise<void> {
	// Heuristic pre-filter: skip trivial conversation
	if (!hasSignificantContent(overflow)) {
		if (isDev) console.log("[promote] Skipped: no significant content");
		return;
	}

	const recentText = overflow
		.map(
			(m) => `${m.role === "user" ? (m.name ?? "User") : "Bot"}: ${m.content}`,
		)
		.join("\n");

	// Build existing fact summary for dedup (include all facts, grouped by subject/category)
	const store = await loadSemanticStore();
	const existingFactSummary =
		store.length > 0
			? store
					.map((f) => `- [${f.subject || f.category}] ${f.content}`)
					.join("\n")
			: undefined;

	// LLM: evaluate and extract
	const result = await evaluateConversationChunk(
		recentText,
		existingFactSummary,
	);

	if (isDev)
		console.log(
			`[promote] Summary: "${result.summary}", importance: ${result.importance}, facts: ${result.facts.length}`,
		);

	// Create episode with embedding
	const episodeEmbedding = await generateEmbedding(result.summary);
	const rawParticipants = [
		...new Set(overflow.map((m) => m.name).filter((n): n is string => !!n)),
	];
	const participants = await Promise.all(
		rawParticipants.map((n) => resolveCanonicalName(n)),
	).then((names) => [...new Set(names)]);

	const now = Date.now();
	await addEpisode(chatId, {
		id: `ep_${now}_${Math.random().toString(36).slice(2, 8)}`,
		summary: result.summary,
		participants,
		timestamp: now,
		importance: result.importance,
		embedding: episodeEmbedding,
	});

	// Add semantic facts with embeddings (canonicalize subjects)
	if (result.facts.length > 0) {
		const semanticFacts: SemanticFact[] = [];
		for (const fact of result.facts) {
			const canonicalSubject = fact.subject
				? await resolveCanonicalName(fact.subject)
				: undefined;
			const factEmbedding = await generateEmbedding(fact.content);
			semanticFacts.push({
				id: `fact_${now}_${Math.random().toString(36).slice(2, 8)}`,
				content: fact.content,
				category: fact.category,
				subject: canonicalSubject,
				context: fact.context,
				embedding: factEmbedding,
				importance: fact.importance,
				confidence: 1.0,
				createdAt: now,
				lastConfirmed: now,
			});
		}
		await addSemanticFacts(semanticFacts);
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

async function downloadAndTranscribeByFileId(
	api: Context["api"],
	botToken: string,
	fileId: string,
	mimeType: string,
	fileExtension: string,
	prefix: string,
	messageId: number,
): Promise<string> {
	const file = await api.getFile(fileId);
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	if (isDev)
		console.log("[downloadAndTranscribeByFileId] Downloading from:", url);

	const response = await fetch(url);
	if (!response.ok) {
		console.error(
			"[downloadAndTranscribeByFileId] Download failed:",
			response.status,
			response.statusText,
		);
		return "[transcription failed]";
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const filePath = `./audios/${prefix}_${messageId}.${fileExtension}`;
	await Bun.write(filePath, buffer);
	if (isDev)
		console.log(
			"[downloadAndTranscribeByFileId] Saved to:",
			filePath,
			`(${buffer.length} bytes)`,
		);

	const transcription = await transcribeAudio(filePath, mimeType);
	if (isDev)
		console.log(
			"[downloadAndTranscribeByFileId] Transcription:",
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

	// Run confidence decay on startup
	decayConfidence().catch(console.error);

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

	// /provider command — switch chat provider (DM only, owner only)
	const VALID_PROVIDERS = [
		"gemini",
		"openrouter",
		"anthropic",
		"azure",
		"alibaba",
	] as const;

	bot.command("provider", async (ctx) => {
		if (isGroupChat(ctx)) return;

		const args = ctx.match?.toString().trim().toLowerCase() ?? "";

		if (!args) {
			const info = getChatProviderInfo();
			await ctx.reply(
				`Proveedor: ${info.provider}\nModelo: ${info.model}\n\nProveedores: ${VALID_PROVIDERS.join(", ")}`,
			);
			return;
		}

		if (!VALID_PROVIDERS.includes(args as (typeof VALID_PROVIDERS)[number])) {
			await ctx.reply(
				`Uso:\n/provider — ver proveedor actual\n/provider <proveedor>\n\nProveedores: ${VALID_PROVIDERS.join(", ")}`,
			);
			return;
		}

		try {
			const provider = switchChatProvider(args);
			await ctx.reply(
				`Cambiado a proveedor: ${provider.name}\nModelo: ${provider.model}`,
			);
		} catch (error) {
			await ctx.reply(`Error cambiando proveedor: ${error}`);
		}
	});

	// /off command — disable bot responses (DM only, owner only)
	bot.command("off", async (ctx) => {
		if (isGroupChat(ctx)) return;
		botOff = true;
		await ctx.reply("😴 Bot apagado. Responderé con 😴 hasta que uses /on.");
	});

	// /on command — re-enable bot responses (DM only, owner only)
	bot.command("on", async (ctx) => {
		if (isGroupChat(ctx)) return;
		botOff = false;
		await ctx.reply("✅ Bot encendido. Respondiendo normalmente.");
	});

	// /optimize command — decay confidence + report stats (DM only, owner only)
	bot.command("optimize", async (ctx) => {
		if (isGroupChat(ctx)) return;

		await ctx.reply("Optimizando memorias...");
		try {
			const result = await decayConfidence();
			await ctx.reply(
				`Optimizado:\n\nSemantic facts: ${result.total}\nEliminados por baja confianza: ${result.removed}`,
			);
		} catch (error) {
			await ctx.reply(`Error optimizando: ${error}`);
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

		// Reply-to-audio: transcribe audio from replied message
		if (!isSimpleAssistantMode) {
			const replyMsg = ctx.message.reply_to_message;
			const replyVoice = replyMsg?.voice;
			const replyAudio = replyMsg?.audio;

			if (replyVoice || replyAudio) {
				if (isGroupChat(ctx) && mentionType === "none") return;

				try {
					const fileId = replyVoice
						? replyVoice.file_id
						: (replyAudio?.file_id as string);
					const mimeType = replyVoice
						? "audio/ogg"
						: (replyAudio?.mime_type ?? "audio/mp3");
					const fileExtension = replyVoice
						? "ogg"
						: (mimeType.split("/")[1] ?? "mp3");
					const prefix = replyVoice ? "voice_reply" : "audio_reply";
					const replyMessageId = replyMsg?.message_id as number;

					const transcription = await downloadAndTranscribeByFileId(
						ctx.api,
						botToken,
						fileId,
						mimeType,
						fileExtension,
						prefix,
						replyMessageId,
					);

					const audioSenderUser = replyMsg?.from;
					const audioSender = audioSenderUser
						? (audioSenderUser.first_name ??
							audioSenderUser.username ??
							"Unknown")
						: "Unknown";

					const content = text
						? `[Audio from ${audioSender}, transcription requested by ${userName}]: ${transcription}\n\n${userName}'s message: "${text}"`
						: `[Audio from ${audioSender}, transcription requested by ${userName}]: ${transcription}`;

					await processConversation(ctx, content, userName, mentionType);
				} catch (error) {
					console.error("[reply-to-audio handler] Error:", error);
					if (isDev)
						await ctx
							.reply(`[Dev] Reply-to-audio error: ${error}`)
							.catch(() => {});
				}
				return;
			}
		}

		// In groups, only respond when mentioned
		if (isGroupChat(ctx) && mentionType === "none") return;

		await processConversation(ctx, text, userName, mentionType);
	});
}
