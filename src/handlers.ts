// Core handler module: security middleware, text catch-all handler, and
// registerHandlers(). The voice/audio and photo handlers live in
// src/handlers/, sharing the routing helpers from src/handlers/routing.ts
// (re-exported here to keep existing import paths working).
import type { Bot, Context, MiddlewareFn } from "grammy";
import { classifyGroupMessageIntent } from "./ai/classifiers.ts";
import { analyzeYouTube, describeImage } from "./ai/vision.ts";
import { isBotOff, isSleepingHour } from "./bot-state.ts";
import { startChatAction, withChatAction } from "./chat-actions.ts";
import { registerCommands } from "./commands.ts";
import { getBotName, isBotConfigured, loadConfig } from "./config.ts";
import {
	getUserDisplayName,
	isGroupChat,
	observeConversationTurn,
} from "./conversation.ts";
import {
	canAutoReplyInGroup,
	canEvaluateSpontaneousReplyInGroup,
	claimGroupContinuationSlot,
	registerGroupAutoReply,
	registerSpontaneousReplyEvaluation,
} from "./group-state.ts";
import {
	handlePdfDocument,
	registerDocumentHandler,
} from "./handlers/document.ts";
import { registerPhotoHandler } from "./handlers/photo.ts";
import {
	buildReplyAwareTextContent,
	detectMentionType,
	getLastBotMessageBeforeLatest,
	getTelegramReplyContext,
	hasEditIntent,
	isIgnorableGroupMessage,
	processConversationAndTrackGroupContinuation,
	routeGroupNameMention,
	sanitizeBracketText,
	toClassifierReplyContext,
} from "./handlers/routing.ts";
import { registerVoiceHandlers } from "./handlers/voice.ts";
import { log } from "./logger.ts";
import {
	cleanupFile,
	downloadAndTranscribeByFileId,
	extractYouTubeUrl,
} from "./media-handlers.ts";
import { decayConfidence, loadSensory } from "./memory/index.ts";
import { isSimpleAssistantMode } from "./prompt/modes.ts";
import { createChatProvider } from "./providers/index.ts";
import { supportsInlineImages } from "./providers/types.ts";
import { processSetupConversation } from "./setup.ts";
import { isDev, safeMediaExtension } from "./utils.ts";

const ALLOWED_GROUP_ID = Number(process.env.ALLOWED_GROUP_ID);
const OWNER_USER_ID = Number(process.env.OWNER_USER_ID);

// User ids already told they lack access; reply once per id per process.
const notifiedUnauthorizedUsers = new Set<number>();
const MAX_NOTIFIED_UNAUTHORIZED_USERS = 1000;

export { isBotOff, isSleepingHour } from "./bot-state.ts";
export {
	buildPassiveVoiceContent,
	buildReplyAwareTextContent,
	buildUntranscribedVoiceContent,
	buildVoiceContent,
	detectMentionType,
	detectTranscribedMentionType,
	getLastBotMessageBeforeLatest,
	getTelegramReplyContext,
	isIgnorableGroupMessage,
	isUsableTranscription,
	shouldTranscribePassiveGroupVoice,
	type TelegramReplyContext,
} from "./handlers/routing.ts";
export type { MentionType } from "./types.ts";

// Security: only allow the owner (DMs) and the permitted group
export const securityMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
	const chatId = ctx.chat?.id;
	if (isGroupChat(ctx)) {
		if (chatId !== ALLOWED_GROUP_ID) {
			log.info(`[guard] Unauthorized group ${chatId}, leaving...`);
			if (chatId) {
				await ctx.api
					.leaveChat(chatId)
					.catch((e) => log.error("[guard] Failed to leave:", e));
			}
			return;
		}
	} else if (ctx.from?.id !== OWNER_USER_ID) {
		log.info(`[guard] Unauthorized DM from user ${ctx.from?.id}, ignoring`);
		const userId = ctx.from?.id;
		if (
			userId &&
			ctx.message &&
			!notifiedUnauthorizedUsers.has(userId) &&
			notifiedUnauthorizedUsers.size < MAX_NOTIFIED_UNAUTHORIZED_USERS
		) {
			notifiedUnauthorizedUsers.add(userId);
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
};

export function registerHandlers(bot: Bot): void {
	const botToken = bot.token;

	// Run confidence decay on startup
	decayConfidence().catch(log.error);

	bot.use(securityMiddleware);

	// Slash commands
	registerCommands(bot);

	// Voice messages and audio files
	registerVoiceHandlers(bot, botToken);

	// Photos
	registerPhotoHandler(bot, botToken);

	// PDF documents, including scanned pages and embedded images
	registerDocumentHandler(bot, botToken);

	// Text messages (catch-all)
	bot.on("message", async (ctx) => {
		const text = ctx.message.text;
		if (!text) return;
		if (text.startsWith("/")) return;
		const userName = getUserDisplayName(ctx);
		const mentionType = detectMentionType(ctx, ctx.me.id);
		const replyContext = getTelegramReplyContext(ctx, ctx.me.id);
		const replyAwareText = buildReplyAwareTextContent(text, replyContext);

		if (isGroupChat(ctx) && mentionType === "name") {
			const route = await routeGroupNameMention(ctx, text, userName);
			if (route === "handled") return;
		}

		// YouTube analysis disabled in simple assistant mode
		const yt = isSimpleAssistantMode ? null : extractYouTubeUrl(ctx);
		if (yt) {
			if (isGroupChat(ctx) && mentionType === "none") {
				await observeConversationTurn(ctx, replyAwareText, userName);
				return;
			}
			const analysis = await analyzeYouTube(
				yt.url,
				yt.remainingText || undefined,
			);
			const content = yt.remainingText
				? `[YouTube video from ${userName}, message: "${yt.remainingText}"]: ${analysis}`
				: `[YouTube video from ${userName}]: ${analysis}`;
			await processConversationAndTrackGroupContinuation(
				ctx,
				content,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
			);
			return;
		}

		// Reply-to-audio/photo/PDF: process media from the replied message
		{
			const replyMsg = ctx.message.reply_to_message;
			const replyVoice = replyMsg?.voice;
			const replyAudio = replyMsg?.audio;
			const replyPhoto = replyMsg?.photo;
			const replyDocument = replyMsg?.document;

			if (replyDocument) {
				const documentSenderUser = replyMsg?.from;
				const documentSender = documentSenderUser
					? (documentSenderUser.first_name ??
						documentSenderUser.username ??
						"Unknown")
					: "Unknown";
				const handled = await handlePdfDocument(ctx, botToken, replyDocument, {
					requestText: text,
					documentSender,
					messageId: replyMsg?.message_id,
				});
				if (handled) return;
			}

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
					const fileId = replyVoice ? replyVoice.file_id : replyAudio?.file_id;
					const replyMessageId = replyMsg?.message_id;
					if (!fileId || replyMessageId === undefined) return;
					const mimeType = replyVoice
						? "audio/ogg"
						: (replyAudio?.mime_type ?? "audio/mp3");
					const fileExtension = replyVoice
						? "ogg"
						: safeMediaExtension(mimeType.split("/")[1], "mp3");
					const prefix = replyVoice ? "voice_reply" : "audio_reply";

					// Receipt feedback while the replied audio downloads + transcribes
					const transcription = await withChatAction(ctx, "typing", () =>
						downloadAndTranscribeByFileId(
							ctx.api,
							botToken,
							fileId,
							mimeType,
							fileExtension,
							prefix,
							replyMessageId,
						),
					);

					const audioSenderUser = replyMsg?.from;
					const audioSender = sanitizeBracketText(
						audioSenderUser
							? (audioSenderUser.first_name ??
									audioSenderUser.username ??
									"Unknown")
							: "Unknown",
					);

					const safeName = sanitizeBracketText(userName);
					const content = text
						? `[Audio from ${audioSender}, transcription requested by ${safeName}]: ${transcription}\n\n${safeName}'s message: "${text}"`
						: `[Audio from ${audioSender}, transcription requested by ${safeName}]: ${transcription}`;

					await processConversationAndTrackGroupContinuation(
						ctx,
						content,
						userName,
						mentionType,
						isBotOff(),
						isSleepingHour(),
					);
				} catch (error) {
					log.error("[reply-to-audio handler] Error:", error);
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

				// Receipt feedback while the replied photo downloads and gets
				// pre-analyzed; stopped before processConversation takes over.
				const receiving = startChatAction(ctx, "typing");
				try {
					const photo = replyPhoto[replyPhoto.length - 1];
					if (!photo) throw new Error("No photo found in replied message");
					const replyMessageId = replyMsg?.message_id;
					if (replyMessageId === undefined) return;
					const file = await ctx.api.getFile(photo.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					log.debug("[reply-to-photo] Downloading file:", file.file_path);

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
					const filePath = `./audios/photo_reply_${replyMessageId}.${ext}`;
					const imageBuffer = Buffer.from(await response.arrayBuffer());
					await Bun.write(filePath, imageBuffer);
					log.debug(
						"[reply-to-photo] Saved to:",
						filePath,
						`(${imageBuffer.length} bytes)`,
					);

					const photoSenderUser = replyMsg?.from;
					const photoSender = sanitizeBracketText(
						photoSenderUser
							? (photoSenderUser.first_name ??
									photoSenderUser.username ??
									"Unknown")
							: "Unknown",
					);
					const safeName = sanitizeBracketText(userName);

					const provider = createChatProvider();

					try {
						if (supportsInlineImages(provider)) {
							// Pass raw image inline (Gemini can see it)
							const data = imageBuffer.toString("base64");
							const content = text
								? `[Image from ${photoSender}]\n\n${safeName}'s message: "${text}"`
								: `[Image from ${photoSender}]`;
							receiving.stop();
							await processConversationAndTrackGroupContinuation(
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
									? `[Image from ${photoSender}]\n\n${safeName}'s message: "${text}"`
									: `[Image from ${photoSender}]`;
							} else {
								const replyCaption = replyMsg?.caption;
								const description = await describeImage(
									filePath,
									mimeType,
									replyCaption ?? undefined,
								);
								content = text
									? `[Image from ${photoSender}]: ${description}\n\n${safeName}'s message: "${text}"`
									: `[Image from ${photoSender}]: ${description}`;
							}
							receiving.stop();
							await processConversationAndTrackGroupContinuation(
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
					log.error("[reply-to-photo handler] Error:", error);
					if (isDev)
						await ctx
							.reply(`[Dev] Reply-to-photo error: ${error}`)
							.catch(() => {});
				} finally {
					// Idempotent: guards against the indicator leaking on early errors.
					receiving.stop();
				}
				return;
			}
		}

		// In groups, observe everything and occasionally evaluate whether to join.
		if (isGroupChat(ctx) && mentionType === "none") {
			await observeConversationTurn(ctx, replyAwareText, userName);
			if (replyContext && !replyContext.isBot) return;
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
					replyContext: toClassifierReplyContext(replyContext),
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
					replyContext: toClassifierReplyContext(replyContext),
				});
				canStartSpontaneously = decision === "respond";
			}

			if (canContinue || canStartSpontaneously) {
				const botOff = isBotOff();
				const sleeping = isSleepingHour();
				if (canStartSpontaneously) {
					registerGroupAutoReply(ctx.chat.id);
				}
				await processConversationAndTrackGroupContinuation(
					ctx,
					replyAwareText,
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
			}
			return;
		}

		// Reply-to-text: include quoted message content for context
		if (replyContext) {
			await processConversationAndTrackGroupContinuation(
				ctx,
				replyAwareText,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
			);
			return;
		}

		await processConversationAndTrackGroupContinuation(
			ctx,
			replyAwareText,
			userName,
			mentionType,
			isBotOff(),
			isSleepingHour(),
		);
	});
}
