import type { Context } from "grammy";
import { describeImage } from "./ai/vision.ts";
import { cleanupFile, downloadImageByFileId } from "./media-handlers.ts";
import { createChatProvider } from "./providers/index.ts";
import {
	type MediaAttachment,
	supportsInlineImages,
} from "./providers/types.ts";
import type { ConversationMessage, ImageReference } from "./types.ts";

export const RECENT_IMAGE_MAX_AGE_MS = 30 * 60 * 1000;

export function imageDocumentMimeType(document?: {
	mime_type?: string;
	file_name?: string;
}): string | undefined {
	const mime = document?.mime_type?.toLowerCase();
	if (mime && ["image/jpeg", "image/png", "image/webp"].includes(mime))
		return mime;
	const ext = document?.file_name?.split(".").pop()?.toLowerCase();
	return ext === "jpg" || ext === "jpeg"
		? "image/jpeg"
		: ext === "png"
			? "image/png"
			: ext === "webp"
				? "image/webp"
				: undefined;
}

export function getMessageImage(ctx: Context): ImageReference | undefined {
	const message =
		ctx.message?.photo?.length || imageDocumentMimeType(ctx.message?.document)
			? ctx.message
			: ctx.message?.reply_to_message;
	const photo = message?.photo?.at(-1);
	const mimeType = imageDocumentMimeType(message?.document);
	if (message?.document && mimeType) {
		return {
			fileId: message.document.file_id,
			messageId: message.message_id,
			mimeType,
		};
	}
	return photo && message
		? { fileId: photo.file_id, messageId: message.message_id }
		: undefined;
}

/** One recent image, scoped to this chat's sensory buffer and the current speaker. */
export function selectRecentImage(
	messages: ConversationMessage[],
	userId: number | undefined,
	now = Date.now(),
): ConversationMessage | undefined {
	if (userId === undefined) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message?.image || message.role !== "user" || message.userId !== userId)
			continue;
		// Do not fall back to an older photo after the latest one expires.
		return now - message.timestamp <= RECENT_IMAGE_MAX_AGE_MS
			? message
			: undefined;
	}
	return undefined;
}

export interface PreparedImageContext {
	filePath: string;
	mediaAttachment?: MediaAttachment;
	description?: string;
}

export async function prepareImageContext(
	ctx: Context,
	image: ImageReference,
	question: string,
): Promise<PreparedImageContext> {
	const { filePath, mimeType } = await downloadImageByFileId(
		ctx.api,
		ctx.api.token,
		image.fileId,
		image.mimeType,
	);
	try {
		if (supportsInlineImages(createChatProvider())) {
			const data = Buffer.from(await Bun.file(filePath).arrayBuffer()).toString(
				"base64",
			);
			return { filePath, mediaAttachment: { data, mimeType } };
		}
		const description = await describeImage(filePath, mimeType, question);
		if (
			!description.trim() ||
			description.trim() === "[image description failed]"
		) {
			throw new Error("Image analysis unavailable");
		}
		return {
			filePath,
			description,
		};
	} catch (error) {
		await cleanupFile(filePath);
		throw error;
	}
}
