import { unlink } from "node:fs/promises";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import { getBaseImagePath } from "./appearance.ts";
import type { ChatActionHandle } from "./chat-actions.ts";
import { getBotName, loadConfig } from "./config.ts";
import { editImage, generateImage } from "./image/index.ts";
import { getWeekStart } from "./image-scheduler.ts";
import { log } from "./logger.ts";
import { cleanupFile, downloadImageByFileId } from "./media-handlers.ts";
import { loadSensory, saveSensory, withChatLock } from "./memory/index.ts";
import {
	currentOperationSignal,
	isTimeoutError,
} from "./operation-deadline.ts";
import { isFullAccessActive, isSimpleAssistantMode } from "./prompt/modes.ts";
import { buildReplyOptions, parseResponse } from "./response-plan.ts";
import { withMarkdownFallback } from "./telegram-delivery.ts";
import { textToSpeech } from "./tts/index.ts";
import type { DeliveredSelfie, SensoryBuffer } from "./types.ts";

export {
	buildReplyOptions,
	extractQuoteReplyMarker,
	IMAGE_EDIT_MARKER_REGEX,
	IMAGE_MARKER_REGEX,
	IMAGE_SELF_MARKER_REGEX,
	QUOTE_REPLY_MARKER,
	REACTION_MARKER_REGEX,
	SILENCE_MARKER,
} from "./response-plan.ts";

export interface SendResponseOptions {
	ctx: Context;
	responseText: string;
	lastSelfie?: DeliveredSelfie;
	requestText?: string;
	uncertainOverlap?: boolean;
	shouldGenImage: boolean;
	allowPhotoRequest: boolean;
	buffer: SensoryBuffer;
	isGroup: boolean;
	userImagePath?: string;
	/** Already generated for an explicitly requested saved task. */
	preparedImage?: Buffer;
	preparedImageOnly?: boolean;
	/** Live indicator from the caller; switched per modality (photo/voice). */
	chatAction?: ChatActionHandle;
}

export interface SendResponseResult {
	preparedPhotoId?: number;
	cleanedText: string;
	bufferDirty: boolean;
	sent: boolean;
}

export interface ResponseDependencies {
	generateImage: typeof generateImage;
	editImage: typeof editImage;
	downloadImage: typeof downloadImageByFileId;
	textToSpeech: typeof textToSpeech;
	baseImage: typeof getBaseImagePath;
	fullAccess: typeof isFullAccessActive;
}
export const defaultResponseDependencies: ResponseDependencies = {
	generateImage,
	editImage,
	downloadImage: downloadImageByFileId,
	textToSpeech,
	baseImage: getBaseImagePath,
	fullAccess: isFullAccessActive,
};

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
		await withMarkdownFallback((parseMode) =>
			ctx.reply(chunk, {
				...replyOptions,
				...(parseMode ? { parse_mode: parseMode } : {}),
			}),
		);
		offset = end;
	}
}

async function preparePhoto(
	options: SendResponseOptions,
	plan: ReturnType<typeof parseResponse>,
	dependencies: ResponseDependencies,
): Promise<
	{ photo: InputFile | string; self: boolean; description: string } | undefined
> {
	const { chatAction, ctx, lastSelfie, userImagePath } = options;
	const followUp = plan.selfieFollowUp;
	if (followUp && lastSelfie) {
		chatAction?.update("upload_photo");
		if (followUp.action === "resend") {
			return {
				photo: lastSelfie.fileId,
				self: true,
				description: "Resent the same selfie",
			};
		}
		const { filePath } = await dependencies.downloadImage(
			ctx.api,
			ctx.api.token,
			lastSelfie.fileId,
		);
		try {
			const image = await dependencies.editImage(
				`Take another photo of this same moment. Preserve the person's identity, exact outfit, location, lighting and visual medium. Requested change: ${followUp.prompt}`,
				filePath,
			);
			return {
				photo: new InputFile(image, "selfie.png"),
				self: true,
				description: `Sent another take of the same selfie: ${followUp.prompt}`,
			};
		} finally {
			await cleanupFile(filePath);
		}
	}
	if (!plan.image) return;
	const { prompt, edit, self } = plan.image;
	const needsReference = !edit && (self || !dependencies.fullAccess());
	const reference = needsReference ? dependencies.baseImage() : undefined;
	if ((needsReference && !reference) || (edit && !userImagePath)) return;
	chatAction?.update("upload_photo");
	try {
		const image =
			edit && userImagePath
				? await dependencies.editImage(prompt, userImagePath)
				: await dependencies.generateImage(prompt, reference ?? undefined);
		return {
			photo: new InputFile(image, `${getBotName().toLowerCase()}.png`),
			self,
			description: `${self ? "Selfie" : "Image"} sent: ${prompt}`,
		};
	} catch (error) {
		log.error("[image] Generation failed:", error);
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
		allowImages: shouldGenImage || allowPhotoRequest,
		allowImageEdits: !!userImagePath,
		allowSpeech: !isSimpleAssistantMode,
		hasDeliveredSelfie: !!options.lastSelfie && !isSimpleAssistantMode,
	});
	const replyOptions = buildReplyOptions({
		isGroup: options.isGroup,
		messageId: ctx.message?.message_id,
		quoteReplyRequested: plan.quoteReplyRequested,
	});
	let sent = false;
	let bufferDirty = false;
	if (options.preparedImageOnly && !options.preparedImage)
		throw new Error("Image-only report has no prepared image");
	if (options.preparedImage) {
		chatAction?.update("upload_photo");
		const photo = await ctx.replyWithPhoto(
			new InputFile(options.preparedImage, "report.png"),
			{
				caption:
					!options.preparedImageOnly && plan.text.length <= 1000
						? plan.text || undefined
						: undefined,
				...replyOptions,
			},
		);
		if (!options.preparedImageOnly && plan.text.length > 1000)
			await sendTextReply(ctx, plan.text, replyOptions);
		return {
			sent: true,
			cleanedText: plan.text,
			bufferDirty: false,
			preparedPhotoId: photo.message_id,
		};
	}
	if (plan.reaction) {
		try {
			await ctx.react(plan.reaction as ReactionTypeEmoji["emoji"]);
			sent = true;
		} catch (error) {
			log.error("[reaction] Failed:", error);
		}
	}
	const followUp = plan.selfieFollowUp;
	if (
		options.uncertainOverlap &&
		(plan.image?.self || followUp?.action === "resend")
	)
		return null;
	if (plan.image || followUp) {
		let prepared: Awaited<ReturnType<typeof preparePhoto>>;
		try {
			prepared = await preparePhoto(options, plan, dependencies);
		} catch (error) {
			currentOperationSignal()?.throwIfAborted();
			if (isTimeoutError(error) || followUp?.action !== "retake") throw error;
			log.warn(
				"[image] Could not prepare another take of the delivered selfie",
			);
			const text =
				loadConfig().language === "en"
					? "I couldn't make another shot from that photo. Can we try again?"
					: "No pude hacer otra toma a partir de esa foto. ¿Lo intentamos de nuevo?";
			await sendTextReply(ctx, text, replyOptions);
			return { sent: true, cleanedText: text, bufferDirty: false };
		}
		if (prepared) {
			const { photo, self, description } = prepared;
			const delivered = await ctx.replyWithPhoto(photo, {
				caption: plan.text.length <= 1000 ? plan.text || undefined : undefined,
				...replyOptions,
			});
			const fileId = delivered.photo?.at(-1)?.file_id;
			const requestMessageId = ctx.message?.message_id;
			const receipt =
				self && fileId && requestMessageId
					? {
							fileId,
							messageId: delivered.message_id,
							requestMessageId,
							requesterId: ctx.from?.id,
							requestText: options.requestText?.slice(0, 1000) ?? "",
							sentAt: delivered.date * 1000,
						}
					: undefined;
			const newPhoto = !plan.image?.edit && followUp?.action !== "resend";
			const consumeWeekly = newPhoto && shouldGenImage;
			const consumeRequest = newPhoto && allowPhotoRequest;
			if (receipt || consumeWeekly || consumeRequest) {
				await withChatLock(buffer.chatId, async () => {
					const fresh = await loadSensory(buffer.chatId);
					if (receipt) fresh.lastSelfie = receipt;
					if (consumeWeekly) fresh.lastImageDate = getWeekStart();
					if (consumeRequest) fresh.allowPhotoRequest = false;
					if (consumeWeekly || consumeRequest) {
						fresh.imageTargetDate = buffer.imageTargetDate;
						fresh.imageTargetTime = buffer.imageTargetTime;
					}
					await saveSensory(fresh);
				});
				bufferDirty = true;
			}
			if (plan.text.length > 1000)
				await sendTextReply(ctx, plan.text, replyOptions);
			return {
				sent: true,
				cleanedText: self
					? [plan.text, `[${description}]`].filter(Boolean).join("\n")
					: plan.text || `[${description}]`,
				bufferDirty,
			};
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
