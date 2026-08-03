import { unlink } from "node:fs/promises";
import type { Context } from "grammy";
import { log } from "./logger.ts";
import { transcribeAudio } from "./stt/index.ts";
import { safeMediaExtension } from "./utils.ts";

async function cleanupFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
		log.debug("[cleanup] Deleted:", filePath);
	} catch {
		// File may already be cleaned up
	}
}

export async function downloadAndTranscribe(
	ctx: Context,
	botToken: string,
	mimeType: string,
	fileExtension: string,
	prefix: string,
): Promise<string> {
	const file = await ctx.getFile();
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	log.debug("[downloadAndTranscribe] Downloading file:", file.file_path);

	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		log.error(
			"[downloadAndTranscribe] Download failed:",
			response.status,
			response.statusText,
		);
		return "[transcription failed]";
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const filePath = `./audios/${prefix}_${ctx.message?.message_id}.${fileExtension}`;
	await Bun.write(filePath, buffer);
	log.debug(
		"[downloadAndTranscribe] Saved to:",
		filePath,
		`(${buffer.length} bytes)`,
	);

	try {
		const transcription = await transcribeAudio(filePath, mimeType);
		log.debug(
			"[downloadAndTranscribe] Transcription:",
			transcription.slice(0, 200),
		);
		return transcription;
	} finally {
		await cleanupFile(filePath);
	}
}

export async function downloadAndTranscribeByFileId(
	api: Context["api"],
	botToken: string,
	fileId: string,
	mimeType: string,
	fileExtension: string,
	prefix: string,
	messageId: number,
): Promise<string> {
	const file = await api.getFile(fileId);
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	log.debug(
		"[downloadAndTranscribeByFileId] Downloading file:",
		file.file_path,
	);

	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		log.error(
			"[downloadAndTranscribeByFileId] Download failed:",
			response.status,
			response.statusText,
		);
		return "[transcription failed]";
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const filePath = `./audios/${prefix}_${messageId}.${fileExtension}`;
	await Bun.write(filePath, buffer);
	log.debug(
		"[downloadAndTranscribeByFileId] Saved to:",
		filePath,
		`(${buffer.length} bytes)`,
	);

	try {
		const transcription = await transcribeAudio(filePath, mimeType);
		log.debug(
			"[downloadAndTranscribeByFileId] Transcription:",
			transcription.slice(0, 200),
		);
		return transcription;
	} finally {
		await cleanupFile(filePath);
	}
}

export async function downloadImage(
	ctx: Context,
	botToken: string,
): Promise<{ filePath: string; mimeType: string }> {
	const photos = ctx.message?.photo;
	// Telegram sends multiple sizes; pick the largest
	const photo = photos?.[photos.length - 1];
	if (!photo) throw new Error("No photo in message");
	const file = await ctx.api.getFile(photo.file_id);
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	log.debug("[downloadImage] Downloading file:", file.file_path);

	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	const rawExt = file.file_path?.split(".").pop();
	const ext = safeMediaExtension(rawExt, "jpg");
	const mimeType = ext === "png" ? "image/png" : "image/jpeg";
	const filePath = `./audios/photo_${ctx.message?.message_id}.${ext}`;
	const buffer = Buffer.from(await response.arrayBuffer());
	await Bun.write(filePath, buffer);
	log.debug("[downloadImage] Saved to:", filePath, `(${buffer.length} bytes)`);

	return { filePath, mimeType };
}

export async function downloadPdfByFileId(
	api: Context["api"],
	botToken: string,
	fileId: string,
	messageId: number,
): Promise<string> {
	const file = await api.getFile(fileId);
	if (!file.file_path)
		throw new Error("Telegram did not return a PDF file path");
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	log.debug("[downloadPdf] Downloading file:", file.file_path);

	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	const filePath = `./audios/pdf_${messageId}.pdf`;
	const buffer = Buffer.from(await response.arrayBuffer());
	await Bun.write(filePath, buffer);
	log.debug("[downloadPdf] Saved to:", filePath, `(${buffer.length} bytes)`);
	return filePath;
}

export { cleanupFile };

export const YOUTUBE_REGEX =
	/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]+)/;

export function extractYouTubeUrl(
	ctx: Context,
): { url: string; remainingText: string } | null {
	const text = ctx.message?.text ?? "";
	const entities = ctx.message?.entities ?? [];

	// Check URL entities first
	for (const entity of entities) {
		if (entity.type === "url" || entity.type === "text_link") {
			const entityUrl =
				entity.type === "text_link"
					? (entity.url ?? "")
					: text.slice(entity.offset, entity.offset + entity.length);
			if (YOUTUBE_REGEX.test(entityUrl)) {
				const remaining = (
					text.slice(0, entity.offset) +
					text.slice(entity.offset + entity.length)
				).trim();
				return { url: entityUrl, remainingText: remaining };
			}
		}
	}

	// Regex fallback
	const match = text.match(YOUTUBE_REGEX);
	if (match) {
		const remaining = text.replace(match[0], "").trim();
		return { url: match[0], remainingText: remaining };
	}

	return null;
}
