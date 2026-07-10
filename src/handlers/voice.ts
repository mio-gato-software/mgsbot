// Voice and audio message handlers, including the group router for
// transcribed voice notes.
import type { Bot, Context } from "grammy";
import { classifyGroupMessageIntent } from "../ai/classifiers.ts";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { getBotName } from "../config.ts";
import {
	getUserDisplayName,
	isGroupChat,
	observeConversationTurn,
} from "../conversation.ts";
import { claimGroupContinuationSlot } from "../group-state.ts";
import { log } from "../logger.ts";
import { downloadAndTranscribe } from "../media-handlers.ts";
import { loadSensory } from "../memory/index.ts";
import type { MentionType } from "../types.ts";
import { isDev, safeMediaExtension } from "../utils.ts";
import {
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
	processConversationAndTrackGroupContinuation,
	routeGroupNameMention,
	shouldTranscribePassiveGroupVoice,
	toClassifierReplyContext,
} from "./routing.ts";

const showTranscription = process.env.SHOW_TRANSCRIPTION === "true";

async function routeGroupTranscribedVoice(
	ctx: Context,
	transcription: string,
	userName: string,
	initialMentionType: MentionType,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const replyContext = getTelegramReplyContext(ctx, ctx.me.id);
	const content = buildVoiceContent(userName, transcription);
	if (initialMentionType !== "none") {
		await processConversationAndTrackGroupContinuation(
			ctx,
			buildReplyAwareTextContent(content, replyContext),
			userName,
			initialMentionType,
			isBotOff(),
			isSleepingHour(),
			undefined,
			true,
		);
		return;
	}

	if (!isUsableTranscription(transcription)) {
		await observeConversationTurn(
			ctx,
			`[Voice message from ${userName}: transcription failed]`,
			userName,
		);
		return;
	}

	const transcribedMentionType = detectTranscribedMentionType(
		ctx,
		ctx.me.id,
		transcription,
	);
	if (transcribedMentionType === "name") {
		const route = await routeGroupNameMention(ctx, transcription, userName, {
			conversationContent: content,
			isVoiceMessage: true,
		});
		if (route === "handled") return;

		await processConversationAndTrackGroupContinuation(
			ctx,
			buildReplyAwareTextContent(content, replyContext),
			userName,
			"name",
			isBotOff(),
			isSleepingHour(),
			undefined,
			true,
		);
		return;
	}

	const passiveContent = buildReplyAwareTextContent(
		buildPassiveVoiceContent(userName, transcription),
		replyContext,
	);
	await observeConversationTurn(ctx, passiveContent, userName);
	if (replyContext && !replyContext.isBot) return;
	if (isIgnorableGroupMessage(transcription)) return;

	if (!claimGroupContinuationSlot(chatId)) return;

	const buffer = await loadSensory(chatId);
	const lastBotMessage = getLastBotMessageBeforeLatest(buffer.messages);
	const decision = await classifyGroupMessageIntent({
		mode: "continuation",
		botName: getBotName(),
		currentSpeaker: userName,
		currentMessage: transcription,
		recentMessages: buffer.messages,
		lastBotMessage,
		replyContext: toClassifierReplyContext(replyContext),
	});

	if (decision !== "respond") return;

	await processConversationAndTrackGroupContinuation(
		ctx,
		passiveContent,
		userName,
		"none",
		isBotOff(),
		isSleepingHour(),
		undefined,
		true,
		undefined,
		{
			skipHistoricalContext: true,
			userTurnAlreadyRecorded: true,
			groupContinuation: true,
		},
	);
}

export function registerVoiceHandlers(bot: Bot, botToken: string): void {
	// Voice messages
	bot.on("message:voice", async (ctx) => {
		const mentionType = detectMentionType(ctx, ctx.me.id);
		const userName = getUserDisplayName(ctx);
		const isGroup = isGroupChat(ctx);
		const duration = ctx.message.voice.duration;
		if (
			isGroup &&
			mentionType === "none" &&
			!shouldTranscribePassiveGroupVoice(duration)
		) {
			await observeConversationTurn(
				ctx,
				buildUntranscribedVoiceContent(userName, duration),
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
			if (showTranscription && (!isGroup || mentionType !== "none")) {
				await ctx
					.reply(`📝 ${transcription}`, {
						reply_to_message_id: ctx.message?.message_id,
					})
					.catch((err) =>
						log.error("[voice] Failed to show transcription:", err),
					);
			}
			if (isGroup) {
				await routeGroupTranscribedVoice(
					ctx,
					transcription,
					userName,
					mentionType,
				);
				return;
			}

			const content = buildVoiceContent(userName, transcription);
			await processConversationAndTrackGroupContinuation(
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
			log.error("[voice handler] Error:", error);
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
					.catch((err) =>
						log.error("[audio] Failed to show transcription:", err),
					);
			}
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversationAndTrackGroupContinuation(
				ctx,
				content,
				userName,
				mentionType,
				isBotOff(),
				isSleepingHour(),
			);
		} catch (error) {
			log.error("[audio handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Audio handler error: ${error}`).catch(() => {});
		}
	});
}
