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
import { log } from "../logger.ts";
import { cleanupFile, downloadPdfByFileId } from "../media-handlers.ts";
import { isSimpleAssistantMode } from "../prompt/modes.ts";
import { isDev } from "../utils.ts";
import {
	detectMentionType,
	processConversationAndTrackGroupContinuation,
	sanitizeBracketText,
} from "./routing.ts";

export interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export function isPdfDocument(document?: TelegramDocument): boolean {
	if (!document) return false;
	return (
		document.mime_type?.toLowerCase() === "application/pdf" ||
		document.file_name?.toLowerCase().endsWith(".pdf") === true
	);
}

function pdfMarker(sender: string, fileName: string, request?: string): string {
	const requestMarker = request
		? `, message: "${sanitizeBracketText(request)}"`
		: "";
	return `[PDF from ${sanitizeBracketText(sender)}, file: "${sanitizeBracketText(fileName)}"${requestMarker}]`;
}

export async function handlePdfDocument(
	ctx: Context,
	botToken: string,
	document: TelegramDocument,
	options?: {
		requestText?: string;
		documentSender?: string;
		messageId?: number;
	},
): Promise<boolean> {
	if (!isPdfDocument(document)) return false;
	if (isSimpleAssistantMode) return true;

	const mentionType = detectMentionType(ctx, ctx.me.id);
	const userName = getUserDisplayName(ctx);
	const documentSender = options?.documentSender ?? userName;
	const requestText = options?.requestText ?? ctx.message?.caption;
	const safeRequestText = requestText
		? sanitizeBracketText(requestText)
		: undefined;
	const fileName = document.file_name ?? "document.pdf";
	const marker = pdfMarker(documentSender, fileName, safeRequestText);

	if (isGroupChat(ctx) && mentionType === "none") {
		await observeConversationTurn(ctx, marker, userName);
		return true;
	}

	const receiving = startChatAction(ctx, "typing");
	let filePath: string | undefined;
	try {
		filePath = await downloadPdfByFileId(
			ctx.api,
			botToken,
			document.file_id,
			options?.messageId ?? ctx.message?.message_id ?? Date.now(),
		);
		const analysis = await analyzePdf(filePath, requestText);
		const safeName = sanitizeBracketText(userName);
		const content = safeRequestText
			? `${marker}\n\n[PDF analysis of text and visual content]\n${analysis}\n\n${safeName}'s message: "${safeRequestText}"`
			: `${marker}\n\n[PDF analysis of text and visual content]\n${analysis}`;

		receiving.stop();
		await processConversationAndTrackGroupContinuation(
			ctx,
			content,
			userName,
			mentionType,
			isBotOff(),
			isSleepingHour(),
		);
	} catch (error) {
		log.error("[PDF handler] Error:", error);
		const language = loadConfig().language ?? "es";
		await ctx
			.reply(
				language === "en"
					? "I couldn't read that PDF. Please try again with a smaller or valid PDF file."
					: "No pude leer ese PDF. Intenta de nuevo con un archivo PDF válido o más pequeño.",
			)
			.catch(() => {});
		if (isDev) log.debug("[PDF handler] Detailed error:", error);
	} finally {
		receiving.stop();
		if (filePath) await cleanupFile(filePath);
	}
	return true;
}

export function registerDocumentHandler(bot: Bot, botToken: string): void {
	bot.on("message:document", async (ctx) => {
		await handlePdfDocument(ctx, botToken, ctx.message.document);
	});
}
