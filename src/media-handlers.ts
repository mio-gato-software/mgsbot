import { unlink } from "node:fs/promises";
import type { Context } from "grammy";
import { transcribeAudio } from "./stt/index.ts";
import { safeMediaExtension } from "./utils.ts";

const isDev = process.env.NODE_ENV === "development";

async function cleanupFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
		if (isDev) console.log("[cleanup] Deleted:", filePath);
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
	if (isDev) console.log("[downloadAndTranscribe] Downloading from:", url);

	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		console.error(
			"[downloadAndTranscribe] Download failed:",
			response.status,
			response.statusText,
		);
		return "[transcription failed]";
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const filePath = `./audios/${prefix}_${ctx.message?.message_id}.${fileExtension}`;
	await Bun.write(filePath, buffer);
	if (isDev)
		console.log(
			"[downloadAndTranscribe] Saved to:",
			filePath,
			`(${buffer.length} bytes)`,
		);

	const transcription = await transcribeAudio(filePath, mimeType);
	if (isDev)
		console.log(
			"[downloadAndTranscribe] Transcription:",
			transcription.slice(0, 200),
		);

	await cleanupFile(filePath);
	return transcription;
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
	if (isDev)
		console.log("[downloadAndTranscribeByFileId] Downloading from:", url);

	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		console.error(
			"[downloadAndTranscribeByFileId] Download failed:",
			response.status,
			response.statusText,
		);
		return "[transcription failed]";
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const filePath = `./audios/${prefix}_${messageId}.${fileExtension}`;
	await Bun.write(filePath, buffer);
	if (isDev)
		console.log(
			"[downloadAndTranscribeByFileId] Saved to:",
			filePath,
			`(${buffer.length} bytes)`,
		);

	const transcription = await transcribeAudio(filePath, mimeType);
	if (isDev)
		console.log(
			"[downloadAndTranscribeByFileId] Transcription:",
			transcription.slice(0, 200),
		);

	await cleanupFile(filePath);
	return transcription;
}

export async function downloadImage(
	ctx: Context,
	botToken: string,
): Promise<{ filePath: string; mimeType: string }> {
	const photos = ctx.message?.photo;
	if (!photos) throw new Error("No photo in message");
	// Telegram sends multiple sizes; pick the largest
	const photo = photos[photos.length - 1];
	const file = await ctx.api.getFile(photo.file_id);
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	if (isDev) console.log("[downloadImage] Downloading from:", url);

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
	if (isDev)
		console.log(
			"[downloadImage] Saved to:",
			filePath,
			`(${buffer.length} bytes)`,
		);

	return { filePath, mimeType };
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
