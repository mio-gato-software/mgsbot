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
import { getMessageImage } from "../image-context.ts";
import { log } from "../logger.ts";
import { cleanupFile, downloadImageByFileId } from "../media-handlers.ts";
import { isSimpleAssistantMode } from "../prompt/modes.ts";
import { createChatProvider } from "../providers/index.ts";
import {
	type MediaAttachment,
	supportsInlineImages,
} from "../providers/types.ts";
import { isDev } from "../utils.ts";
import {
	detectMentionType,
	hasEditIntent,
	processConversationAndTrackGroupContinuation,
	sanitizeBracketText,
} from "./routing.ts";

export async function handlePhoto(
	ctx: Context,
	botToken: string,
	requestText = ctx.message?.caption,
): Promise<void> {
	if (isSimpleAssistantMode) return;
	const mentionType = detectMentionType(ctx, ctx.me.id);
	const userName = getUserDisplayName(ctx);
	const image = getMessageImage(ctx);
	if (!image) return;
	const source =
		image.messageId === ctx.message?.message_id
			? ctx.message
			: ctx.message?.reply_to_message;
	const imageName = sanitizeBracketText(source?.from?.first_name ?? userName);
	if (isGroupChat(ctx) && mentionType === "none") {
		const caption = requestText;
		const observedContent = caption
			? `[Image from ${imageName}, caption: "${sanitizeBracketText(caption)}"]`
			: `[Image from ${imageName}]`;
		await observeConversationTurn(ctx, observedContent, userName);
		return;
	}
	// Receipt feedback while the image downloads and gets pre-analyzed.
	// Stopped right before processConversation, which runs its own
	// indicator (and may switch it to upload_photo for edit requests).
	const receiving = startChatAction(ctx, "typing");
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
				const description = await describeImage(filePath, mimeType, question);
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
			await processConversationAndTrackGroupContinuation(
				ctx,
				content,
				userName,
				{
					mentionType,
					botOff: isBotOff(),
					isSleepingHour: isSleepingHour(),
					mediaAttachment,
					userImagePath: filePath,
				},
			);
		} finally {
			await cleanupFile(filePath);
		}
	} catch (error) {
		log.error("[photo handler] Error:", error);
		await ctx
			.reply(
				loadConfig().language === "en"
					? "I couldn't read that image. Reply to the original image to try again."
					: "No pude leer esa imagen. Responde a la imagen original para intentarlo de nuevo.",
			)
			.catch(() => {});
		if (isDev)
			await ctx.reply(`[Dev] Photo handler error: ${error}`).catch(() => {});
	} finally {
		// Idempotent: guards against the indicator leaking on early errors.
		receiving.stop();
	}
}

export function registerPhotoHandler(bot: Bot, botToken: string): void {
	bot.on("message:photo", (ctx) => handlePhoto(ctx, botToken));
}
