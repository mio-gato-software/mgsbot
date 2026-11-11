import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { type Context, GrammyError, HttpError } from "grammy";
import { alertOwner } from "./alerts.ts";
import { log } from "./logger.ts";
import {
	currentOperationSignal,
	isTimeoutError,
	requestSignal,
	withDeadline,
} from "./operation-deadline.ts";
import { transcribeAudio } from "./stt/index.ts";
import { safeMediaExtension, withRetry } from "./utils.ts";

export const MAX_TEXT_ATTACHMENT_BYTES = 1_000_000;

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
	return transcribeTelegramFile(
		() =>
			ctx.getFile(
				currentOperationSignal() as Parameters<Context["getFile"]>[0],
			),
		botToken,
		mimeType,
		fileExtension,
		prefix,
		ctx.message?.message_id,
	);
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
	return transcribeTelegramFile(
		() =>
			api.getFile(
				fileId,
				currentOperationSignal() as Parameters<Context["api"]["getFile"]>[1],
			),
		botToken,
		mimeType,
		fileExtension,
		prefix,
		messageId,
	);
}

function audioDownloadErrorDetails(error: unknown): string {
	const cause = error instanceof HttpError ? error.error : error;
	const code =
		cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
	const status = error instanceof GrammyError ? error.error_code : undefined;
	return [error instanceof Error ? error.name : "Unknown error", status, code]
		.filter((value) => value !== undefined)
		.join(" / ");
}

async function transcribeTelegramFile(
	getFile: () => ReturnType<Context["getFile"]>,
	botToken: string,
	mimeType: string,
	fileExtension: string,
	prefix: string,
	messageId: number | undefined,
): Promise<string> {
	// Retry only the read-only download. Transcription and delivery each run once.
	const buffer = await withRetry(
		() =>
			withDeadline("Telegram audio download", 30_000, async () => {
				const file = await getFile();
				if (!file.file_path)
					throw new Error("Telegram did not return an audio file path");
				let response: Response;
				let bytes: ArrayBuffer;
				try {
					response = await fetch(
						`https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
						{ signal: requestSignal() },
					);
					if (!response.ok) {
						await response.body?.cancel();
						throw new GrammyError(
							"Audio download failed",
							{
								ok: false,
								error_code: response.status,
								description: response.statusText,
							},
							"getFile",
							{},
						);
					}
					bytes = await response.arrayBuffer();
				} catch (error) {
					currentOperationSignal()?.throwIfAborted();
					if (error instanceof GrammyError) throw error;
					throw new HttpError("Audio download connection failed", error);
				}
				return Buffer.from(bytes);
			}),
		3,
		500,
		{
			shouldRetry: (error) => {
				const retryable =
					error instanceof HttpError ||
					isTimeoutError(error) ||
					(error instanceof GrammyError &&
						[429, 500, 502, 503, 504].includes(error.error_code));
				if (retryable)
					log.warn(
						"[telegram-audio] Download failed; retrying:",
						audioDownloadErrorDetails(error),
					);
				return retryable;
			},
			delayMs: (error, delay) =>
				error instanceof GrammyError
					? Math.max(delay, (error.parameters.retry_after ?? 0) * 1000)
					: delay,
		},
	).catch(async (error) => {
		// Keep the failed operation visible to the operator even during passive listening.
		log.error("[telegram-audio] Download failed permanently:", error);
		await alertOwner(
			"telegram-audio-download",
			`No se pudo descargar un audio de Telegram. ${audioDownloadErrorDetails(error)}. El error completo quedó registrado en el servicio.`,
		);
		throw error;
	});
	const filePath = `./audios/${prefix}_${messageId}_${randomUUID()}.${fileExtension}`;
	try {
		await Bun.write(filePath, buffer);
		return await transcribeAudio(filePath, mimeType);
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
	return downloadImageByFileId(ctx.api, botToken, photo.file_id);
}

export async function downloadImageByFileId(
	api: Context["api"],
	botToken: string,
	fileId: string,
	declaredMimeType?: string,
): Promise<{ filePath: string; mimeType: string }> {
	const file = await api.getFile(fileId);
	if (!file.file_path)
		throw new Error("Telegram did not return an image file path");
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	log.debug("[downloadImage] Downloading file:", file.file_path);

	const response = await fetch(url, { signal: requestSignal(30_000) });
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	const rawExt = file.file_path?.split(".").pop();
	const ext = safeMediaExtension(rawExt, "jpg");
	const mimeType =
		declaredMimeType ??
		(ext === "png"
			? "image/png"
			: ext === "webp"
				? "image/webp"
				: "image/jpeg");
	const filePath = `./audios/photo_${randomUUID()}.${ext}`;
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

	const response = await fetch(url, { signal: requestSignal(60_000) });
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	const filePath = `./audios/pdf_${messageId}_${randomUUID()}.pdf`;
	const buffer = Buffer.from(await response.arrayBuffer());
	await Bun.write(filePath, buffer);
	log.debug("[downloadPdf] Saved to:", filePath, `(${buffer.length} bytes)`);
	return filePath;
}

function decodeTextBytes(buffer: Uint8Array): string {
	let encoding: "utf-8" | "utf-16" = "utf-8";
	let offset = 0;
	let bytes = buffer;
	if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		offset = 3;
	} else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		encoding = "utf-16";
		offset = 2;
	} else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		encoding = "utf-16";
		const bigEndianBytes = buffer.subarray(2);
		if (bigEndianBytes.byteLength % 2 !== 0) {
			throw new Error(
				"Text attachment is not valid UTF-8 or BOM-marked UTF-16",
			);
		}
		bytes = new Uint8Array(bigEndianBytes.byteLength);
		for (let index = 0; index < bigEndianBytes.byteLength; index += 2) {
			bytes[index] = bigEndianBytes[index + 1] ?? 0;
			bytes[index + 1] = bigEndianBytes[index] ?? 0;
		}
	}

	let text: string;
	try {
		text = new TextDecoder(encoding, { fatal: true }).decode(
			bytes.subarray(offset),
		);
	} catch {
		throw new Error("Text attachment is not valid UTF-8 or BOM-marked UTF-16");
	}

	if (text.includes("\0")) {
		throw new Error("Text attachment contains binary data");
	}

	const normalized = text.replace(/^\uFEFF/u, "");
	if (!normalized.trim()) throw new Error("Text attachment is empty");
	return normalized;
}

export function readTextAttachmentBytes(buffer: Uint8Array): string {
	if (buffer.byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
		throw new Error("Text attachment is too large");
	}
	return decodeTextBytes(buffer);
}

async function readLimitedTextResponse(
	response: Response,
): Promise<Uint8Array> {
	const contentLength = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(contentLength) &&
		contentLength > MAX_TEXT_ATTACHMENT_BYTES
	) {
		throw new Error("Text attachment is too large");
	}

	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_TEXT_ATTACHMENT_BYTES) {
			await reader.cancel().catch(() => {});
			throw new Error("Text attachment is too large");
		}
		chunks.push(value);
	}

	const buffer = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer;
}

export async function downloadTextByFileId(
	api: Context["api"],
	botToken: string,
	fileId: string,
): Promise<string> {
	const file = await api.getFile(fileId);
	if (!file.file_path)
		throw new Error("Telegram did not return a text file path");
	const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
	log.debug("[downloadText] Downloading file:", file.file_path);

	const response = await fetch(url, { signal: requestSignal(30_000) });
	if (!response.ok) {
		throw new Error(
			`Download failed: ${response.status} ${response.statusText}`,
		);
	}

	const buffer = await readLimitedTextResponse(response);
	log.debug("[downloadText] Read text attachment:", `(${buffer.length} bytes)`);
	return readTextAttachmentBytes(buffer);
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
