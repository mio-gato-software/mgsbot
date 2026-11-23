// Photo message handler.
import type { Bot, Context } from "grammy";
import { describeImage } from "../ai/vision.ts";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { startChatAction } from "../chat-actions.ts";
import { loadConfig } from "../config.ts";
import {
	getUserDisplayName,
	isGroupChat,
	observeConversationTurn,
} from "../conversation.ts";
import { releaseGroupReconsideration } from "../group-autonomy.ts";
import { claimGroupContinuationSlot } from "../group-state.ts";
import { getMessageImage } from "../image-context.ts";
import { log } from "../logger.ts";
import { cleanupFile, downloadImageByFileId } from "../media-handlers.ts";
import { isTimeoutError } from "../operation-deadline.ts";
import { isSimpleAssistantMode } from "../prompt/modes.ts";
import { createChatProvider } from "../providers/index.ts";
import {
	type MediaAttachment,
	supportsInlineImages,
} from "../providers/types.ts";
import type { MentionType } from "../types.ts";
import { preflightGroupWork } from "./group-preflight.ts";
import {
	classifyGroupTurn,
	detectMentionType,
	hasEditIntent,
	processConversationAndTrackGroupContinuation,
	sanitizeBracketText,
} from "./routing.ts";

export async function handlePhoto(
	ctx: Context,
	botToken: string,
	requestText = ctx.message?.caption,
	knownMentionType?: MentionType,
): Promise<void> {
	if (isSimpleAssistantMode) return;
	const image = getMessageImage(ctx);
	if (!image) return;
	const userName = getUserDisplayName(ctx);
	const telegram = knownMentionType ?? detectMentionType(ctx, ctx.me.id);
	const group = isGroupChat(ctx);
	const decision =
		knownMentionType === undefined &&
		telegram === "none" &&
		group &&
		requestText
			? await classifyGroupTurn(ctx, requestText, userName, true)
			: null;
	const mentionType =
		decision?.action === "respond" && decision.addressing === "direct"
			? "name"
			: telegram;
	const groupContinuation =
		mentionType === "none" &&
		decision?.action === "respond" &&
		decision.addressing === "continuation" &&
		!ctx.message?.reply_to_message &&
		ctx.chat !== undefined &&
		claimGroupContinuationSlot(ctx.chat.id);
	const source =
		image.messageId === ctx.message?.message_id
			? ctx.message
			: ctx.message?.reply_to_message;
	const imageName = sanitizeBracketText(source?.from?.first_name ?? userName);
	const marker = requestText
		? `[Image from ${imageName}, caption: "${sanitizeBracketText(requestText)}"]`
		: `[Image from ${imageName}]`;
	if (group && mentionType === "none" && !groupContinuation) {
		await observeConversationTurn(ctx, marker, userName);
		return;
	}
	const preflight = await preflightGroupWork(ctx, {
		requestKind: "media",
		text: requestText,
		content: marker,
		userName,
		options: { mentionType, groupContinuation },
	});
	if (preflight.handled) return;

	// Receipt feedback while the image downloads and gets pre-analyzed.
	// Stopped right before processConversation, which runs its own
	// indicator (and may switch it to upload_photo for edit requests).
	const receiving = startChatAction(ctx, "typing");
	let responding = false;
	try {
		const { filePath, mimeType } = await downloadImageByFileId(
			ctx.api,
			botToken,
			image.fileId,
			image.mimeType,
		);
		const caption = requestText;
		const safeCaption = caption ? sanitizeBracketText(caption) : caption;
		try {
			const provider = createChatProvider();
			let content = `[Image from ${imageName}]`;
			let description: string | undefined;
			let mediaAttachment: MediaAttachment | undefined;
			if (supportsInlineImages(provider)) {
				const data = Buffer.from(
					await Bun.file(filePath).arrayBuffer(),
				).toString("base64");
				mediaAttachment = { data, mimeType };
			} else if (!(await hasEditIntent(caption))) {
				// Edit providers use the raw file; other requests need question-focused evidence.
				const question =
					source !== ctx.message
						? [source?.caption, caption].filter(Boolean).join("\n")
						: caption;
				description = await describeImage(filePath, mimeType, question);
				if (
					!description.trim() ||
					description.trim() === "[image description failed]"
				) {
					throw new Error("Image analysis unavailable");
				}
				content += `: ${description}`;
			}
			if (source !== ctx.message && source?.caption) {
				content += `\nOriginal caption: "${sanitizeBracketText(source.caption)}"`;
			}
			if (safeCaption)
				content += `\n\n${sanitizeBracketText(userName)}'s message: "${safeCaption}"`;
			receiving.stop();
			responding = true;
			await processConversationAndTrackGroupContinuation(
				ctx,
				content,
				userName,
				{
					mentionType,
					groupContinuation,
					botOff: isBotOff(),
					isSleepingHour: isSleepingHour(),
					groupRequestDecision: preflight.groupRequestDecision,
					mediaAttachment,
					imageDescription: description,
					userImagePath: filePath,
				},
			);
		} finally {
			await cleanupFile(filePath);
		}
	} catch (error) {
		if (!responding)
			await releaseGroupReconsideration(ctx, preflight.groupRequestDecision);
		if (isTimeoutError(error)) throw error;
		log.error("[photo handler] Error:", error);
		await ctx
			.reply(
				responding
					? loadConfig().language === "en"
						? "I couldn't complete the response to that image. Reply to the original image to try again."
						: "No pude completar la respuesta a esa imagen. Responde a la imagen original para intentarlo de nuevo."
					: loadConfig().language === "en"
						? "I couldn't read that image. Reply to the original image to try again."
						: "No pude leer esa imagen. Responde a la imagen original para intentarlo de nuevo.",
			)
			.catch(() => {});
	} finally {
		// Idempotent: guards against the indicator leaking on early errors.
		receiving.stop();
	}
}

export function registerPhotoHandler(bot: Bot, botToken: string): void {
	bot.on("message:photo", (ctx) => handlePhoto(ctx, botToken));
}
