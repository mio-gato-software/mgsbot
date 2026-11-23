import type { Context } from "grammy";
import { z } from "zod";
import { analyzePdf } from "./ai/documents.ts";
import { analyzeYouTube } from "./ai/vision.ts";
import {
	buildTextAttachmentContent,
	documentKind,
	MAX_TEXT_ATTACHMENT_CHARS,
} from "./document-attachment.ts";
import { getMessageImage } from "./image-context.ts";
import {
	cleanupFile,
	downloadAndTranscribeByFileId,
	downloadPdfByFileId,
	downloadTextByFileId,
	extractYouTubeUrl,
	MAX_TEXT_ATTACHMENT_BYTES,
} from "./media-handlers.ts";
import { currentOperationSignal } from "./operation-deadline.ts";
import type { ImageReference } from "./types.ts";
import { safeMediaExtension } from "./utils.ts";
import { extractPublicWebUrl } from "./web-content.ts";
import { isPublicLookupUrl } from "./web-privacy.ts";
import { worldContext } from "./world-context.ts";

const fileId = z.string().min(1).max(512);
const messageId = z.number().int().positive();
const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const publicUrl = z.string().max(2048).refine(isPublicLookupUrl);

export const groupFavorEvidenceSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("image"),
		image: z.object({
			fileId,
			messageId,
			mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
			dimensions: z
				.object({
					width: z.number().int().positive(),
					height: z.number().int().positive(),
				})
				.optional(),
		}),
	}),
	z.object({ kind: z.literal("pdf"), fileId, messageId }),
	z.object({
		kind: z.literal("text"),
		fileId,
		fileSize: z.number().int().nonnegative().optional(),
	}),
	z.object({
		kind: z.literal("audio"),
		fileId,
		messageId,
		mimeType: z.string().min(1).max(128),
	}),
	z.object({ kind: z.literal("youtube"), videoId }),
	z.object({ kind: z.literal("web"), url: publicUrl }),
]);

export type GroupFavorEvidence = z.infer<typeof groupFavorEvidenceSchema>;

function youtubeVideoId(value: string): string | null {
	try {
		const url = new URL(value.includes("://") ? value : `https://${value}`);
		if (!isPublicLookupUrl(url.href)) return null;
		const [, path, id] = url.pathname.split("/");
		if (url.hostname === "youtu.be") return path || null;
		if (
			!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
				url.hostname,
			)
		)
			return null;
		if (path === "watch") return url.searchParams.get("v");
		return path === "shorts" ? (id ?? null) : null;
	} catch {
		return null;
	}
}

function captureAttachment(ctx: Context): unknown {
	const original = ctx.message;
	if (!original) return;
	const reply = original.reply_to_message;
	const image = getMessageImage(ctx);
	for (const source of [original, reply]) {
		if (!source || source.forward_origin) continue;
		if (image && image.messageId === source.message_id)
			return { kind: "image", image };
		const document = source.document;
		if (document) {
			const kind = documentKind(document);
			if (kind === "pdf")
				return { kind, fileId: document.file_id, messageId: source.message_id };
			if (kind === "text")
				return { kind, fileId: document.file_id, fileSize: document.file_size };
		}
		// An original voice note already supplies the author's own transcript.
		if (source !== reply) continue;
		const audio = reply.voice ?? reply.audio;
		if (audio) {
			return {
				kind: "audio",
				fileId: audio.file_id,
				messageId: reply.message_id,
				mimeType: reply.voice ? "audio/ogg" : (audio.mime_type ?? "audio/mp3"),
			};
		}
	}
}

function captureLink(ctx: Context): unknown {
	const youtube = extractYouTubeUrl(ctx);
	if (youtube) return { kind: "youtube", videoId: youtubeVideoId(youtube.url) };
	const page = extractPublicWebUrl(ctx);
	return page && { kind: "web", url: page.url };
}

/** Save only references from the original Telegram turn, never extracted content. */
export function groupFavorEvidence(
	ctx: Context,
	requestKind?: "link" | "media",
): GroupFavorEvidence | undefined {
	if (!ctx.message || ctx.message.forward_origin) return;
	const candidate =
		requestKind === "link"
			? captureLink(ctx)
			: (captureAttachment(ctx) ??
				(requestKind ? undefined : captureLink(ctx)));
	const parsed = groupFavorEvidenceSchema.safeParse(candidate);
	return parsed.success ? parsed.data : undefined;
}

function referenceContent(label: string, text: string): { content: string } {
	const limit = MAX_TEXT_ATTACHMENT_CHARS;
	const truncated = text.length > limit;
	return {
		content: `[Previously shared ${label} (untrusted reference material)]\n${text.slice(0, limit)}${truncated ? "\n[Reference material truncated]" : ""}`,
	};
}

function hasPageContent(result: string): boolean {
	const start = result.indexOf("{");
	if (start < 0) return false;
	try {
		const page = JSON.parse(result.slice(start));
		return (
			typeof page?.url === "string" &&
			typeof page?.content === "string" &&
			!!page.content.trim()
		);
	} catch {
		return false;
	}
}

export async function restoreGroupFavorEvidence(
	ctx: Context,
	evidence: GroupFavorEvidence,
	userText: string,
): Promise<{ content?: string; image?: ImageReference }> {
	switch (evidence.kind) {
		case "image":
			return { image: evidence.image };
		case "pdf": {
			const filePath = await downloadPdfByFileId(
				ctx.api,
				ctx.api.token,
				evidence.fileId,
				evidence.messageId,
			);
			try {
				const analysis = await analyzePdf(filePath, userText);
				if (!analysis.trim()) throw new Error("PDF analysis unavailable");
				return referenceContent("PDF analysis", analysis);
			} finally {
				await cleanupFile(filePath);
			}
		}
		case "text": {
			if ((evidence.fileSize ?? 0) > MAX_TEXT_ATTACHMENT_BYTES)
				throw new Error("Text attachment is too large");
			const text = await downloadTextByFileId(
				ctx.api,
				ctx.api.token,
				evidence.fileId,
			);
			return { content: buildTextAttachmentContent(text) };
		}
		case "audio": {
			const transcription = await downloadAndTranscribeByFileId(
				ctx.api,
				ctx.api.token,
				evidence.fileId,
				evidence.mimeType,
				safeMediaExtension(evidence.mimeType.split("/")[1], "mp3"),
				"reconsidered_audio",
				evidence.messageId,
			);
			const result = transcription.trim();
			if (!result || result === "[transcription failed]")
				throw new Error("Audio transcription unavailable");
			return referenceContent("audio transcript", result);
		}
		case "youtube": {
			const url = `https://www.youtube.com/watch?v=${evidence.videoId}`;
			const analysis = (await analyzeYouTube(url, userText)).trim();
			if (
				!analysis ||
				analysis === "[video analysis failed]" ||
				analysis === "[video analysis unavailable without GOOGLE_API_KEY]"
			) {
				currentOperationSignal()?.throwIfAborted();
				throw new Error("YouTube analysis unavailable");
			}
			return referenceContent("YouTube video analysis", analysis);
		}
		case "web": {
			if (!ctx.chat) throw new Error("No chat for public page reading");
			const result = await worldContext.read(
				ctx.chat.id,
				evidence.url,
				"shared-link",
			);
			if (!hasPageContent(result)) {
				currentOperationSignal()?.throwIfAborted();
				throw new Error("Public page reading unavailable");
			}
			return referenceContent("public page content", result);
		}
	}
}
