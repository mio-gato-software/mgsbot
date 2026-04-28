import type { Bot, Context } from "grammy";
import {
	classifyEditIntent,
	classifyGroupMessageIntent,
	classifyGroupSocialIntent,
} from "./ai/classifiers.ts";
import { analyzeYouTube, describeImage } from "./ai/vision.ts";
import { isBotOff, isSleepingHour } from "./bot-state.ts";
import { registerCommands } from "./commands.ts";
import { getBotName, isBotConfigured, loadConfig } from "./config.ts";
import {
	getUserDisplayName,
	isGroupChat,
	observeConversationTurn,
	processConversation,
} from "./conversation.ts";
import {
	cleanupFile,
	downloadAndTranscribe,
	downloadAndTranscribeByFileId,
	downloadImage,
	extractYouTubeUrl,
} from "./media-handlers.ts";
import { decayConfidence, loadSensory } from "./memory/index.ts";
import { isSimpleAssistantMode } from "./prompt/modes.ts";
import { createChatProvider } from "./providers/index.ts";
import { supportsInlineImages } from "./providers/types.ts";
import { processSetupConversation } from "./setup.ts";
import type { ConversationMessage, MentionType } from "./types.ts";
import { safeMediaExtension } from "./utils.ts";

const ALLOWED_GROUP_ID = Number(process.env.ALLOWED_GROUP_ID);
const OWNER_USER_ID = Number(process.env.OWNER_USER_ID);
const isDev = process.env.NODE_ENV === "development";
const showTranscription = process.env.SHOW_TRANSCRIPTION === "true";
const GROUP_SPONTANEOUS_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const GROUP_SPONTANEOUS_EVALUATION_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_SPONTANEOUS_REPLIES_PER_WINDOW = 1;
const GROUP_CONTINUATION_WINDOW_MS = 15 * 60 * 1000;
const GROUP_CONTINUATION_MAX_MESSAGES = 6;

const groupAutoReplyTimestamps = new Map<number, number[]>();
const groupSpontaneousEvaluationTimestamps = new Map<number, number>();
const groupContinuationWindows = new Map<
	number,
	{ expiresAt: number; remainingMessages: number }
>();

/**
 * Regex fallback for edit intent detection when the LLM classifier is unavailable.
 */
const EDIT_INTENT_REGEX =
	/\b(edit|change|modify|add|remove|make it|turn it|turn this|transform|replace|paint|convert|crop|resize|edita|edítala|edítalo|cambia|cámbiale|modifica|modifícala|modifícalo|ponle|pónle|agrégale|agregale|añádele|añadele|quítale|quitale|hazla|hazlo|haz que|conviértela|conviertela|conviértelo|conviertelo|transforma|pinta|píntala|pintalo|reemplaza|sustituye)\b/i;

/**
 * Does the caption express intent to edit/modify the image?
 * When true, we can skip describeImage since the model will likely emit
 * [IMAGE: ...] and the edit provider uses the raw image directly.
 *
 * Uses an LLM classifier for nuance; falls back to a regex if the classifier
 * fails or is inconclusive.
 */
async function hasEditIntent(caption?: string): Promise<boolean> {
	if (!caption) return false;
	const classification = await classifyEditIntent(caption);
	if (classification !== null) return classification;
	return EDIT_INTENT_REGEX.test(caption);
}

export { isBotOff, isSleepingHour } from "./bot-state.ts";
export type { MentionType } from "./types.ts";

export function detectMentionType(ctx: Context, botId: number): MentionType {
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
	const botName = getBotName().toLowerCase();
	const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const nameRegex = new RegExp(`\\b${escaped}\\b`, "i");
	if (nameRegex.test(text)) return "name";

	return "none";
}

function isIgnorableGroupMessage(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) {
		return true;
	}
	return false;
}

function canAutoReplyInGroup(chatId: number): boolean {
	const now = Date.now();
	const recent = (groupAutoReplyTimestamps.get(chatId) ?? []).filter(
		(ts) => now - ts <= GROUP_SPONTANEOUS_COOLDOWN_MS,
	);
	const last = recent[recent.length - 1];
	if (last && now - last < GROUP_SPONTANEOUS_COOLDOWN_MS) {
		groupAutoReplyTimestamps.set(chatId, recent);
		return false;
	}
	if (recent.length >= MAX_SPONTANEOUS_REPLIES_PER_WINDOW) {
		groupAutoReplyTimestamps.set(chatId, recent);
		return false;
	}
	return true;
}

function canEvaluateSpontaneousReplyInGroup(chatId: number): boolean {
	const now = Date.now();
	const last = groupSpontaneousEvaluationTimestamps.get(chatId);
	return !last || now - last >= GROUP_SPONTANEOUS_EVALUATION_COOLDOWN_MS;
}

function registerSpontaneousReplyEvaluation(chatId: number): void {
	groupSpontaneousEvaluationTimestamps.set(chatId, Date.now());
}

function registerGroupAutoReply(chatId: number): void {
	const now = Date.now();
	const recent = (groupAutoReplyTimestamps.get(chatId) ?? []).filter(
		(ts) => now - ts <= GROUP_SPONTANEOUS_COOLDOWN_MS,
	);
	recent.push(now);
	groupAutoReplyTimestamps.set(chatId, recent);
}

function openGroupContinuationWindow(chatId: number): void {
	groupContinuationWindows.set(chatId, {
		expiresAt: Date.now() + GROUP_CONTINUATION_WINDOW_MS,
		remainingMessages: GROUP_CONTINUATION_MAX_MESSAGES,
	});
}

function claimGroupContinuationSlot(chatId: number): boolean {
	const now = Date.now();
	const window = groupContinuationWindows.get(chatId);
	if (!window || window.expiresAt <= now || window.remainingMessages <= 0) {
		groupContinuationWindows.delete(chatId);
		return false;
	}

	window.remainingMessages--;
	if (window.remainingMessages <= 0) {
		groupContinuationWindows.delete(chatId);
	} else {
		groupContinuationWindows.set(chatId, window);
	}
	return true;
}

function getLastBotMessageBeforeLatest(
	messages: ConversationMessage[],
): string | undefined {
	for (let i = messages.length - 2; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "model") return message.content;
	}
	return undefined;
}

async function routeGroupNameMention(
	ctx: Context,
	text: string,
	userName: string,
): Promise<"full" | "handled"> {
	const chatId = ctx.chat?.id;
	if (!chatId) return "handled";

	const buffer = await loadSensory(chatId);
	const currentTurn: ConversationMessage = {
		role: "user",
		name: userName,
		content: text,
		timestamp: Date.now(),
	};
	const recentMessages = [...buffer.messages, currentTurn];
	const lastBotMessage = getLastBotMessageBeforeLatest(recentMessages);
	const decision = await classifyGroupSocialIntent({
		mode: "name",
		botName: getBotName(),
		currentSpeaker: userName,
		currentMessage: text,
		recentMessages,
		lastBotMessage,
	});

	if (decision?.addressing === "direct") {
		return "full";
	}

	await observeConversationTurn(ctx, text, userName);
	if (decision?.action !== "respond") {
		return "handled";
	}

	const didRespond = await processConversation(
		ctx,
		text,
		userName,
		"name",
		isBotOff(),
		isSleepingHour(),
		undefined,
		undefined,
		undefined,
		{
			skipHistoricalContext: true,
			userTurnAlreadyRecorded: true,
			groupAutoReply: decision.addressing !== "continuation",
			groupContinuation: decision.addressing === "continuation",
		},
	);
	if (didRespond) {
		openGroupContinuationWindow(chatId);
	}

	return "handled";
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
			const userId = ctx.from?.id;
			if (userId && ctx.message) {
				await ctx.reply(
					`⚠️ No tienes acceso a este bot.\n\nTu ID de usuario es: \`${userId}\`\n\nComparte este ID con la persona que administra el bot para que te dé acceso.`,
					{ parse_mode: "Markdown" },
				);
			}
			return;
		}

		if (!isBotConfigured()) {
			if (ctx.from?.id === OWNER_USER_ID && !isGroupChat(ctx)) {
				const text = ctx.message?.text;
				if (text) {
					const userName = getUserDisplayName(ctx);
					await processSetupConversation(ctx, text, userName);
				} else {
					const lang = loadConfig().language ?? "es";
					await ctx.reply(
						lang === "en"
							? "Please use text to configure the bot."
							: "Por favor, usa texto para configurar el bot.",
					);
				}
			}
			return;
		}

		await next();
	});

	// Slash commands
	registerCommands(bot);

	// Voice messages
	bot.on("message:voice", async (ctx) => {
		const mentionType = detectMentionType(ctx, ctx.me.id);
		const userName = getUserDisplayName(ctx);
		if (isGroupChat(ctx) && mentionType === "none") {
			await observeConversationTurn(
				ctx,
				`[Voice message from ${userName}]`,
				userName,
			);
			return;
		}
		try {
			const transcription = await downloadAndTranscribe(
				ctx,
				botToken,
				"audio/ogg",
				"ogg",
				"voice",
			);
			if (showTranscription) {
				await ctx
					.reply(`📝 ${transcription}`, {
						reply_to_message_id: ctx.message?.message_id,
					})
					.catch(() => {});
			}
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
				undefined,
				true,
			);
		} catch (error) {
			console.error("[voice handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Voice handler error: ${error}`).catch(() => {});
		}
	});

	// Audio files
	bot.on("message:audio", async (ctx) => {
		const mentionType = detectMentionType(ctx, ctx.me.id);
		const userName = getUserDisplayName(ctx);
		if (isGroupChat(ctx) && mentionType === "none") {
			await observeConversationTurn(
				ctx,
				`[Audio file from ${userName}]`,
				userName,
			);
			return;
		}
		try {
			const ext = safeMediaExtension(
				ctx.message.audio.mime_type?.split("/")[1],
				"mp3",
			);
			const mimeType = ctx.message.audio.mime_type ?? "audio/mp3";
			const transcription = await downloadAndTranscribe(
				ctx,
				botToken,
				mimeType,
				ext,
				"audio",
			);
			if (showTranscription) {
				await ctx
					.reply(`📝 ${transcription}`, {
						reply_to_message_id: ctx.message?.message_id,
					})
					.catch(() => {});
			}
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
			);
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
		const userName = getUserDisplayName(ctx);
		if (isGroupChat(ctx) && mentionType === "none") {
			const caption = ctx.message.caption;
			const observedContent = caption
				? `[Image from ${userName}, caption: "${caption}"]`
				: `[Image from ${userName}]`;
			await observeConversationTurn(ctx, observedContent, userName);
			return;
		}
		try {
			const { filePath, mimeType } = await downloadImage(ctx, botToken);
			const caption = ctx.message.caption;
			const provider = createChatProvider();

			try {
				if (supportsInlineImages(provider)) {
					// Pass raw image inline (Gemini can see it)
					const imageBuffer = await Bun.file(filePath).arrayBuffer();
					const data = Buffer.from(imageBuffer).toString("base64");
					const content = caption
						? `[Image from ${userName}, caption: "${caption}"]`
						: `[Image from ${userName}]`;
					await processConversation(
						ctx,
						content,
						userName,
						mentionType,
						isBotOff(),
						isSleepingHour(),
						{ data, mimeType },
						undefined,
						filePath,
					);
				} else {
					// Non-vision provider. Skip describeImage only when the caption
					// clearly expresses edit intent (the edit provider uses the raw
					// image directly). Otherwise describe so the bot can comment.
					const skipDescribe = await hasEditIntent(caption);
					let content: string;
					if (skipDescribe) {
						content = caption
							? `[Image from ${userName}, caption: "${caption}"]`
							: `[Image from ${userName}]`;
					} else {
						const description = await describeImage(
							filePath,
							mimeType,
							caption,
						);
						content = caption
							? `[Image from ${userName}, caption: "${caption}"]: ${description}`
							: `[Image from ${userName}]: ${description}`;
					}
					await processConversation(
						ctx,
						content,
						userName,
						mentionType,
						isBotOff(),
						isSleepingHour(),
						undefined,
						undefined,
						filePath,
					);
				}
			} finally {
				await cleanupFile(filePath);
			}
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
		if (text.startsWith("/")) return;
		const userName = getUserDisplayName(ctx);
		const mentionType = detectMentionType(ctx, ctx.me.id);

		if (isGroupChat(ctx) && mentionType === "name") {
			const route = await routeGroupNameMention(ctx, text, userName);
			if (route === "handled") return;
		}

		// YouTube analysis disabled in simple assistant mode
		const yt = isSimpleAssistantMode ? null : extractYouTubeUrl(ctx);
		if (yt) {
			if (isGroupChat(ctx) && mentionType === "none") {
				await observeConversationTurn(ctx, text, userName);
				return;
			}
			const analysis = await analyzeYouTube(
				yt.url,
				yt.remainingText || undefined,
			);
			const content = yt.remainingText
				? `[YouTube video from ${userName}, message: "${yt.remainingText}"]: ${analysis}`
				: `[YouTube video from ${userName}]: ${analysis}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
			);
			return;
		}

		// Reply-to-audio/photo: transcribe audio or describe image from replied message
		{
			const replyMsg = ctx.message.reply_to_message;
			const replyVoice = replyMsg?.voice;
			const replyAudio = replyMsg?.audio;
			const replyPhoto = replyMsg?.photo;

			if (replyVoice || replyAudio) {
				if (isGroupChat(ctx) && mentionType === "none") {
					await observeConversationTurn(
						ctx,
						`[Reply to audio by ${userName}]: "${text}"`,
						userName,
					);
					return;
				}

				try {
					const fileId = replyVoice
						? replyVoice.file_id
						: (replyAudio?.file_id as string);
					const mimeType = replyVoice
						? "audio/ogg"
						: (replyAudio?.mime_type ?? "audio/mp3");
					const fileExtension = replyVoice
						? "ogg"
						: safeMediaExtension(mimeType.split("/")[1], "mp3");
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

					await processConversation(
						ctx,
						content,
						userName,
						mentionType,
						isBotOff(),
						isSleepingHour(),
					);
				} catch (error) {
					console.error("[reply-to-audio handler] Error:", error);
					if (isDev)
						await ctx
							.reply(`[Dev] Reply-to-audio error: ${error}`)
							.catch(() => {});
				}
				return;
			}

			// Reply-to-photo: describe image from replied message
			if (replyPhoto && replyPhoto.length > 0) {
				if (isGroupChat(ctx) && mentionType === "none") {
					await observeConversationTurn(
						ctx,
						`[Reply to image by ${userName}]: "${text}"`,
						userName,
					);
					return;
				}

				try {
					const photo = replyPhoto[replyPhoto.length - 1];
					if (!photo) throw new Error("No photo found in replied message");
					const file = await ctx.api.getFile(photo.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					if (isDev) console.log("[reply-to-photo] Downloading from:", url);

					const response = await fetch(url, {
						signal: AbortSignal.timeout(30_000),
					});
					if (!response.ok) {
						throw new Error(
							`Download failed: ${response.status} ${response.statusText}`,
						);
					}

					const ext = safeMediaExtension(
						file.file_path?.split(".").pop(),
						"jpg",
					);
					const mimeType = ext === "png" ? "image/png" : "image/jpeg";
					const replyMessageId = replyMsg?.message_id as number;
					const filePath = `./audios/photo_reply_${replyMessageId}.${ext}`;
					const imageBuffer = Buffer.from(await response.arrayBuffer());
					await Bun.write(filePath, imageBuffer);
					if (isDev)
						console.log(
							"[reply-to-photo] Saved to:",
							filePath,
							`(${imageBuffer.length} bytes)`,
						);

					const photoSenderUser = replyMsg?.from;
					const photoSender = photoSenderUser
						? (photoSenderUser.first_name ??
							photoSenderUser.username ??
							"Unknown")
						: "Unknown";

					const provider = createChatProvider();

					try {
						if (supportsInlineImages(provider)) {
							// Pass raw image inline (Gemini can see it)
							const data = imageBuffer.toString("base64");
							const content = text
								? `[Image from ${photoSender}]\n\n${userName}'s message: "${text}"`
								: `[Image from ${photoSender}]`;
							await processConversation(
								ctx,
								content,
								userName,
								mentionType,
								isBotOff(),
								isSleepingHour(),
								{ data, mimeType },
								undefined,
								filePath,
							);
						} else {
							// Non-vision provider. Skip describeImage only when the
							// current message expresses edit intent.
							const skipDescribe = await hasEditIntent(text);
							let content: string;
							if (skipDescribe) {
								content = text
									? `[Image from ${photoSender}]\n\n${userName}'s message: "${text}"`
									: `[Image from ${photoSender}]`;
							} else {
								const replyCaption = replyMsg?.caption;
								const description = await describeImage(
									filePath,
									mimeType,
									replyCaption ?? undefined,
								);
								content = text
									? `[Image from ${photoSender}]: ${description}\n\n${userName}'s message: "${text}"`
									: `[Image from ${photoSender}]: ${description}`;
							}
							await processConversation(
								ctx,
								content,
								userName,
								mentionType,
								isBotOff(),
								isSleepingHour(),
								undefined,
								undefined,
								filePath,
							);
						}
					} finally {
						await cleanupFile(filePath);
					}
				} catch (error) {
					console.error("[reply-to-photo handler] Error:", error);
					if (isDev)
						await ctx
							.reply(`[Dev] Reply-to-photo error: ${error}`)
							.catch(() => {});
				}
				return;
			}
		}

		// In groups, observe everything and occasionally evaluate whether to join.
		if (isGroupChat(ctx) && mentionType === "none") {
			await observeConversationTurn(ctx, text, userName);
			if (isIgnorableGroupMessage(text)) return;

			const buffer = await loadSensory(ctx.chat.id);
			const lastBotMessage = getLastBotMessageBeforeLatest(buffer.messages);
			let canContinue = false;
			let canStartSpontaneously = false;
			let consideredContinuation = false;

			if (claimGroupContinuationSlot(ctx.chat.id)) {
				consideredContinuation = true;
				const decision = await classifyGroupMessageIntent({
					mode: "continuation",
					botName: getBotName(),
					currentSpeaker: userName,
					currentMessage: text,
					recentMessages: buffer.messages,
					lastBotMessage,
				});
				canContinue = decision === "respond";
			}

			if (
				!canContinue &&
				!consideredContinuation &&
				canAutoReplyInGroup(ctx.chat.id) &&
				canEvaluateSpontaneousReplyInGroup(ctx.chat.id)
			) {
				registerSpontaneousReplyEvaluation(ctx.chat.id);
				const decision = await classifyGroupMessageIntent({
					mode: "spontaneous",
					botName: getBotName(),
					currentSpeaker: userName,
					currentMessage: text,
					recentMessages: buffer.messages,
					lastBotMessage,
				});
				canStartSpontaneously = decision === "respond";
			}

			if (canContinue || canStartSpontaneously) {
				const botOff = isBotOff();
				const sleeping = isSleepingHour();
				if (canStartSpontaneously) {
					registerGroupAutoReply(ctx.chat.id);
				}
				const didRespond = await processConversation(
					ctx,
					text,
					userName,
					mentionType,
					botOff,
					sleeping,
					undefined,
					undefined,
					undefined,
					{
						skipHistoricalContext: true,
						userTurnAlreadyRecorded: true,
						groupAutoReply: canStartSpontaneously,
						groupContinuation: canContinue,
					},
				);
				if (didRespond) {
					openGroupContinuationWindow(ctx.chat.id);
				}
			}
			return;
		}

		// Reply-to-text: include quoted message content for context
		const replyText = ctx.message.reply_to_message?.text;
		if (replyText) {
			const replySenderUser = ctx.message.reply_to_message?.from;
			const replySenderName = replySenderUser
				? (replySenderUser.first_name ?? replySenderUser.username ?? "Unknown")
				: "Unknown";
			const content = `[Respondiendo al mensaje de ${replySenderName}: "${replyText}"]\n\n${text}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
			);
			return;
		}

		await processConversation(
			ctx,
			text,
			userName,
			mentionType,
			isBotOff(),
			isSleepingHour(),
		);
	});
}
