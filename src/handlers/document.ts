import type { Bot, Context } from "grammy";
import { analyzePdf } from "../ai/documents.ts";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { startChatAction } from "../chat-actions.ts";
import { loadConfig } from "../config.ts";
import {
	getUserDisplayName,
	isGroupChat,
	observeConversationTurn,
} from "../conversation.ts";
import {
	buildTextAttachmentContent,
	type DocumentKind,
	documentKind,
	type TelegramDocument,
} from "../document-attachment.ts";
import { releaseGroupReconsideration } from "../group-autonomy.ts";
import { imageDocumentMimeType } from "../image-context.ts";
import { log } from "../logger.ts";
import {
	cleanupFile,
	downloadPdfByFileId,
	downloadTextByFileId,
	MAX_TEXT_ATTACHMENT_BYTES,
} from "../media-handlers.ts";
import { isTimeoutError } from "../operation-deadline.ts";
import { isSimpleAssistantMode } from "../prompt/modes.ts";
import type { MentionType } from "../types.ts";
import { isDev } from "../utils.ts";
import { preflightGroupWork } from "./group-preflight.ts";
import { handlePhoto } from "./photo.ts";
import {
	processConversationAndTrackGroupContinuation,
	resolveMediaMention,
	sanitizeBracketText,
} from "./routing.ts";

export {
	buildTextAttachmentContent,
	isPdfDocument,
	isTextDocument,
	MAX_TEXT_ATTACHMENT_CHARS,
	type TelegramDocument,
} from "../document-attachment.ts";

function documentMarker(
	kind: DocumentKind,
	sender: string,
	fileName: string,
	request?: string,
): string {
	const requestMarker = request
		? `, message: "${sanitizeBracketText(request)}"`
		: "";
	const label = kind === "pdf" ? "PDF" : "Plain-text attachment";
	return `[${label} from ${sanitizeBracketText(sender)}, file: "${sanitizeBracketText(fileName)}"${requestMarker}]`;
}

export async function handleDocument(
	ctx: Context,
	botToken: string,
	document: TelegramDocument,
	options?: {
		requestText?: string;
		mentionType?: MentionType;
		documentSender?: string;
		messageId?: number;
	},
): Promise<boolean> {
	if (imageDocumentMimeType(document)) {
		await handlePhoto(
			ctx,
			botToken,
			options?.requestText ?? ctx.message?.caption,
			options?.mentionType,
		);
		return true;
	}
	const kind = documentKind(document);
	if (!kind) return false;
	if (isSimpleAssistantMode) return true;

	const userName = getUserDisplayName(ctx);
	const documentSender = options?.documentSender ?? userName;
	const requestText = options?.requestText ?? ctx.message?.caption;
	const mentionType =
		options?.mentionType ??
		(await resolveMediaMention(ctx, requestText, userName));
	const safeRequestText = requestText
		? sanitizeBracketText(requestText)
		: undefined;
	const fileName =
		document.file_name ?? (kind === "pdf" ? "document.pdf" : "document.txt");
	const marker = documentMarker(
		kind,
		documentSender,
		fileName,
		safeRequestText,
	);

	if (isGroupChat(ctx) && mentionType === "none") {
		await observeConversationTurn(ctx, marker, userName);
		return true;
	}
	const preflight = await preflightGroupWork(ctx, {
		requestKind: "media",
		text: requestText,
		content: marker,
		userName,
		options: { mentionType },
	});
	if (preflight.handled) return true;

	const receiving = startChatAction(ctx, "typing");
	let filePath: string | undefined;
	let responding = false;
	try {
		let attachmentContent: string;
		if (kind === "pdf") {
			filePath = await downloadPdfByFileId(
				ctx.api,
				botToken,
				document.file_id,
				options?.messageId ?? ctx.message?.message_id ?? Date.now(),
			);
			const analysis = await analyzePdf(filePath, requestText);
			attachmentContent = `[PDF analysis of text and visual content]\n${analysis}`;
		} else {
			if (
				document.file_size !== undefined &&
				document.file_size > MAX_TEXT_ATTACHMENT_BYTES
			) {
				throw new Error("Text attachment is too large");
			}
			const text = await downloadTextByFileId(
				ctx.api,
				botToken,
				document.file_id,
			);
			attachmentContent = buildTextAttachmentContent(text);
		}
		const safeName = sanitizeBracketText(userName);
		const content = safeRequestText
			? `${marker}\n\n${attachmentContent}\n\n${safeName}'s message: "${safeRequestText}"`
			: `${marker}\n\n${attachmentContent}`;

		receiving.stop();
		responding = true;
		await processConversationAndTrackGroupContinuation(ctx, content, userName, {
			mentionType,
			botOff: isBotOff(),
			isSleepingHour: isSleepingHour(),
			groupRequestDecision: preflight.groupRequestDecision,
		});
	} catch (error) {
		if (!responding)
			await releaseGroupReconsideration(ctx, preflight.groupRequestDecision);
		if (isTimeoutError(error)) throw error;
		log.error(`[${kind === "pdf" ? "PDF" : "text"} handler] Error:`, error);
		const language = loadConfig().language ?? "es";
		const errorMessage =
			kind === "pdf"
				? language === "en"
					? "I couldn't read that PDF. Please try again with a smaller or valid PDF file."
					: "No pude leer ese PDF. Intenta de nuevo con un archivo PDF válido o más pequeño."
				: language === "en"
					? "I couldn't read that text file. Please send a valid UTF-8 or UTF-16 .txt file no larger than 1 MB."
					: "No pude leer ese archivo de texto. Envía un .txt UTF-8 o UTF-16 válido de no más de 1 MB.";
		await ctx.reply(errorMessage).catch(() => {});
		if (isDev) log.debug("[document handler] Detailed error:", error);
	} finally {
		receiving.stop();
		if (filePath) await cleanupFile(filePath);
	}
	return true;
}

export function registerDocumentHandler(bot: Bot, botToken: string): void {
	bot.on("message:document", async (ctx) => {
		await handleDocument(ctx, botToken, ctx.message.document);
	});
}
