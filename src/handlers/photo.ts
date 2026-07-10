// Photo message handler.
import type { Bot } from "grammy";
import { describeImage } from "../ai/vision.ts";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { startChatAction } from "../chat-actions.ts";
import {
	getUserDisplayName,
	isGroupChat,
	observeConversationTurn,
} from "../conversation.ts";
import { log } from "../logger.ts";
import { cleanupFile, downloadImage } from "../media-handlers.ts";
import { isSimpleAssistantMode } from "../prompt/modes.ts";
import { createChatProvider } from "../providers/index.ts";
import { supportsInlineImages } from "../providers/types.ts";
import { isDev } from "../utils.ts";
import {
	detectMentionType,
	hasEditIntent,
	processConversationAndTrackGroupContinuation,
	sanitizeBracketText,
} from "./routing.ts";

export function registerPhotoHandler(bot: Bot, botToken: string): void {
	// Photos (disabled in simple assistant mode)
	bot.on("message:photo", async (ctx) => {
		if (isSimpleAssistantMode) return;
		const mentionType = detectMentionType(ctx, ctx.me.id);
		const userName = getUserDisplayName(ctx);
		const safeName = sanitizeBracketText(userName);
		if (isGroupChat(ctx) && mentionType === "none") {
			const caption = ctx.message.caption;
			const observedContent = caption
				? `[Image from ${safeName}, caption: "${sanitizeBracketText(caption)}"]`
				: `[Image from ${safeName}]`;
			await observeConversationTurn(ctx, observedContent, userName);
			return;
		}
		// Receipt feedback while the image downloads and gets pre-analyzed.
		// Stopped right before processConversation, which runs its own
		// indicator (and may switch it to upload_photo for edit requests).
		const receiving = startChatAction(ctx, "typing");
		try {
			const { filePath, mimeType } = await downloadImage(ctx, botToken);
			const caption = ctx.message.caption;
			const safeCaption = caption ? sanitizeBracketText(caption) : caption;
			const provider = createChatProvider();

			try {
				if (supportsInlineImages(provider)) {
					// Pass raw image inline (Gemini can see it)
					const imageBuffer = await Bun.file(filePath).arrayBuffer();
					const data = Buffer.from(imageBuffer).toString("base64");
					const content = caption
						? `[Image from ${safeName}, caption: "${safeCaption}"]`
						: `[Image from ${safeName}]`;
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
					// Non-vision provider. Skip describeImage only when the caption
					// clearly expresses edit intent (the edit provider uses the raw
					// image directly). Otherwise describe so the bot can comment.
					const skipDescribe = await hasEditIntent(caption);
					let content: string;
					if (skipDescribe) {
						content = caption
							? `[Image from ${safeName}, caption: "${safeCaption}"]`
							: `[Image from ${safeName}]`;
					} else {
						const description = await describeImage(
							filePath,
							mimeType,
							caption,
						);
						content = caption
							? `[Image from ${safeName}, caption: "${safeCaption}"]: ${description}`
							: `[Image from ${safeName}]: ${description}`;
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
			log.error("[photo handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Photo handler error: ${error}`).catch(() => {});
		} finally {
			// Idempotent: guards against the indicator leaking on early errors.
			receiving.stop();
		}
	});
}
