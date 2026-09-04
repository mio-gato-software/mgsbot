import { unlink } from "node:fs/promises";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import { getBaseImagePath } from "./appearance.ts";
import type { ChatActionHandle } from "./chat-actions.ts";
import { getBotName } from "./config.ts";
import { editImage, generateImage } from "./image/index.ts";
import { getWeekStart } from "./image-scheduler.ts";
import { log } from "./logger.ts";
import { loadSensory, saveSensory, withChatLock } from "./memory/index.ts";
import { isFullAccessActive, isSimpleAssistantMode } from "./prompt/modes.ts";
import { buildReplyOptions, parseResponse } from "./response-plan.ts";
import { textToSpeech } from "./tts/index.ts";
import type { SensoryBuffer } from "./types.ts";

export {
	buildReplyOptions,
	extractQuoteReplyMarker,
	IMAGE_MARKER_REGEX,
	IMAGE_SELF_MARKER_REGEX,
	QUOTE_REPLY_MARKER,
	REACTION_MARKER_REGEX,
	SILENCE_MARKER,
} from "./response-plan.ts";

export interface SendResponseOptions {
	ctx: Context;
	responseText: string;
	shouldGenImage: boolean;
	allowPhotoRequest: boolean;
	buffer: SensoryBuffer;
	isGroup: boolean;
	userImagePath?: string;
	/** Live indicator from the caller; switched per modality (photo/voice). */
	chatAction?: ChatActionHandle;
}

export interface SendResponseResult {
	cleanedText: string;
	bufferDirty: boolean;
	sent: boolean;
}

export interface ResponseDependencies {
	generateImage: typeof generateImage;
	editImage: typeof editImage;
	textToSpeech: typeof textToSpeech;
	baseImage: typeof getBaseImagePath;
	fullAccess: typeof isFullAccessActive;
}
export const defaultResponseDependencies: ResponseDependencies = {
	generateImage,
	editImage,
	textToSpeech,
	baseImage: getBaseImagePath,
	fullAccess: isFullAccessActive,
};

function isFormattingError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		/can't parse entities|cannot parse entities|unsupported start tag|can't find end of/i.test(
			error.message,
		) &&
		(!("error_code" in error) || error.error_code === 400)
	);
}

/** Only formatting errors warrant a plain-text fallback; transport failures propagate. */
export async function sendTextReply(
	ctx: Context,
	text: string,
	replyOptions: ReturnType<typeof buildReplyOptions> = {},
): Promise<void> {
	for (let offset = 0; offset < text.length; ) {
		let end = Math.min(offset + 4000, text.length);
		// Avoid cutting a UTF-16 surrogate pair across messages.
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
		const chunk = text.slice(offset, end);
		try {
			await ctx.reply(chunk, { ...replyOptions, parse_mode: "Markdown" });
		} catch (error) {
			if (!isFormattingError(error)) throw error;
			await ctx.reply(chunk, replyOptions);
		}
		offset = end;
	}
}

export async function sendResponse(
	options: SendResponseOptions,
	dependencies = defaultResponseDependencies,
): Promise<SendResponseResult | null> {
	const {
		ctx,
		buffer,
		chatAction,
		userImagePath,
		shouldGenImage,
		allowPhotoRequest,
	} = options;
	const plan = parseResponse(options.responseText, {
		allowImages: shouldGenImage || allowPhotoRequest || !!userImagePath,
		allowSpeech: !isSimpleAssistantMode,
	});
	const replyOptions = buildReplyOptions({
		isGroup: options.isGroup,
		messageId: ctx.message?.message_id,
		quoteReplyRequested: plan.quoteReplyRequested,
	});
	let sent = false;
	let bufferDirty = false;
	if (plan.reaction) {
		try {
			await ctx.react(plan.reaction as ReactionTypeEmoji["emoji"]);
			sent = true;
		} catch (error) {
			log.error("[reaction] Failed:", error);
		}
	}
	if (plan.image) {
		const base = dependencies.baseImage();
		const fullAccess = dependencies.fullAccess();
		if (userImagePath || base || fullAccess) {
			let image: Uint8Array | undefined;
			chatAction?.update("upload_photo");
			try {
				image = userImagePath
					? await dependencies.editImage(plan.image.prompt, userImagePath)
					: await dependencies.generateImage(
							plan.image.prompt,
							!fullAccess || plan.image.self ? (base ?? undefined) : undefined,
						);
			} catch (error) {
				log.error("[image] Generation failed:", error);
			}
			if (image) {
				// Long text is delivered separately so it cannot invalidate the photo caption.
				await ctx.replyWithPhoto(
					new InputFile(image, `${getBotName().toLowerCase()}.png`),
					{
						caption:
							plan.text.length <= 1000 ? plan.text || undefined : undefined,
						...replyOptions,
					},
				);
				if (plan.text.length > 1000)
					await sendTextReply(ctx, plan.text, replyOptions);
				const consumeWeekly = !userImagePath && shouldGenImage;
				const consumeRequest = !userImagePath && allowPhotoRequest;
				if (consumeWeekly || consumeRequest) {
					await withChatLock(buffer.chatId, async () => {
						const fresh = await loadSensory(buffer.chatId);
						if (consumeWeekly) fresh.lastImageDate = getWeekStart();
						if (consumeRequest) fresh.allowPhotoRequest = false;
						fresh.imageTargetDate = buffer.imageTargetDate;
						fresh.imageTargetTime = buffer.imageTargetTime;
						await saveSensory(fresh);
					});
					bufferDirty = true;
				}
				return {
					sent: true,
					cleanedText: plan.text || `[Image sent: ${plan.image.prompt}]`,
					bufferDirty,
				};
			}
		}
	}
	if (plan.speech) {
		let audioPath: string | undefined;
		let voiceSent = false;
		chatAction?.update("record_voice");
		try {
			audioPath = await dependencies.textToSpeech(plan.speech);
			await ctx.replyWithVoice(new InputFile(audioPath), replyOptions);
			voiceSent = true;
		} catch (error) {
			log.error("[TTS] Voice delivery failed:", error);
		} finally {
			if (audioPath)
				await unlink(audioPath).catch((error) =>
					log.warn("[TTS] Cleanup failed:", error),
				);
		}
		if (voiceSent) {
			if (plan.textOutsideSpeech)
				await sendTextReply(ctx, plan.textOutsideSpeech, replyOptions);
			if (process.env.SHOW_TRANSCRIPTION === "true")
				await ctx
					.reply(`📝 ${plan.speech}`, replyOptions)
					.catch((error) =>
						log.warn("[TTS] Transcription display failed:", error),
					);
		} else {
			await sendTextReply(ctx, plan.text, replyOptions);
		}
		return { sent: true, cleanedText: plan.text, bufferDirty };
	}
	if (plan.text) {
		chatAction?.update("typing");
		await sendTextReply(ctx, plan.text, replyOptions);
		sent = true;
	}
	return sent ? { sent, cleanedText: plan.text, bufferDirty } : null;
}
