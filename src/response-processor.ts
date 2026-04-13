import { unlink } from "node:fs/promises";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import { getBaseImagePath } from "./appearance.ts";
import { getBotName } from "./config.ts";
import { isFullAccessActive } from "./full-access.ts";
import { editImage, generateImage } from "./image/index.ts";
import { getWeekStart } from "./image-scheduler.ts";
import { saveSensory } from "./memory.ts";
import { isSimpleAssistantMode } from "./prompt/modes.ts";
import { textToSpeech } from "./tts/index.ts";
import type { SensoryBuffer } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";
const showTranscription = process.env.SHOW_TRANSCRIPTION === "true";

export const IMAGE_MARKER_REGEX = /\[IMAGE:\s*([^\]]+)\]/;
export const IMAGE_SELF_MARKER_REGEX = /\[IMAGE_SELF:\s*([^\]]+)\]/;
export const REACTION_MARKER_REGEX = /\[REACT:\s*([^\]]+)\]/;
export const SILENCE_MARKER = "[SILENCE]";

export interface SendResponseOptions {
	ctx: Context;
	responseText: string;
	shouldGenImage: boolean;
	allowPhotoRequest: boolean;
	buffer: SensoryBuffer;
	isGroup: boolean;
	userImagePath?: string;
}

export interface SendResponseResult {
	/** The cleaned response text (markers stripped), for saving to sensory buffer */
	cleanedText: string;
	/** Whether buffer was modified (image tracking state changed) */
	bufferDirty: boolean;
}

/**
 * Process response markers and send the reply to the user.
 * Handles SILENCE, REACT, IMAGE, TTS markers and plain text replies.
 * Returns null if the response was silenced (nothing to save).
 */
export async function sendResponse(
	options: SendResponseOptions,
): Promise<SendResponseResult | null> {
	const {
		ctx,
		shouldGenImage,
		allowPhotoRequest,
		buffer,
		isGroup,
		userImagePath,
	} = options;
	let responseText = options.responseText;

	// Guard against empty responses
	if (!responseText.trim()) {
		if (isDev) console.log("[response] Empty response from model, skipping");
		return null;
	}

	// Check for [SILENCE] marker - bot chose not to respond
	if (responseText.trim() === SILENCE_MARKER) {
		if (isDev) console.log("[response] Bot chose to stay silent");
		return null;
	}

	// Handle [SILENCE] mixed with text - send the text part, strip the marker
	if (responseText.includes(SILENCE_MARKER)) {
		responseText = responseText.replace(SILENCE_MARKER, "").trim();
		if (isDev)
			console.log(
				"[response] Stripped [SILENCE] marker, remaining text:",
				responseText,
			);
		if (!responseText) return null;
	}

	// Check for [REACT:emoji] marker
	const reactionMatch = responseText.match(REACTION_MARKER_REGEX);
	if (reactionMatch) {
		const emoji = reactionMatch[1].trim();
		if (isDev) console.log("[response] Bot reacting with emoji:", emoji);
		try {
			await ctx.react(emoji);
		} catch (error) {
			console.error("[reaction] Error reacting:", error);
		}
		responseText = responseText
			.replace(REACTION_MARKER_REGEX, "")
			.replace(/`/g, "")
			.trim();
		if (!responseText) return { cleanedText: "", bufferDirty: false };
	}

	// Reply options
	const replyOptions = {
		reply_to_message_id: isGroup ? ctx.message?.message_id : undefined,
	};

	// Extract TTS markers up-front so they never leak into an image caption
	// when [IMAGE:...] and [TTS]...[/TTS] co-occur. Tolerate a missing slash
	// in the closing tag since the model occasionally emits that variant.
	const TTS_REGEX = /\[TTS\]([\s\S]+?)\[\/?TTS\]/;
	const ttsMatch = isSimpleAssistantMode ? null : responseText.match(TTS_REGEX);
	const ttsText = ttsMatch ? ttsMatch[1].trim() : null;
	if (ttsText) {
		responseText = responseText.replace(TTS_REGEX, ttsText).trim();
	}

	// Check for image marker
	// If the user attached an image this turn, always allow the marker (edit intent).
	const canGenerateImage =
		shouldGenImage || allowPhotoRequest || !!userImagePath;

	// `[IMAGE_SELF: ...]` is a full-access marker for self-in-scene pictures
	// (always references the character base for consistency). Plain
	// `[IMAGE: ...]` in full-access mode is a subject-only picture (no base image),
	// so "send me a picture of a cat" yields just a cat.
	const selfMatch = canGenerateImage
		? responseText.match(IMAGE_SELF_MARKER_REGEX)
		: null;
	const imageMatch = canGenerateImage
		? (selfMatch ?? responseText.match(IMAGE_MARKER_REGEX))
		: null;
	const isSelfImage = !!selfMatch;
	if (!canGenerateImage) {
		responseText = responseText
			.replace(IMAGE_SELF_MARKER_REGEX, "")
			.replace(IMAGE_MARKER_REGEX, "")
			.trim();
	}
	let imageSent = false;
	let bufferDirty = false;

	if (imageMatch) {
		const extractedPrompt = imageMatch[1].trim();
		responseText = responseText
			.replace(IMAGE_SELF_MARKER_REGEX, "")
			.replace(IMAGE_MARKER_REGEX, "")
			.trim();
		const basePath = getBaseImagePath();
		const isEdit = !!userImagePath;
		// In full-access mode, plain [IMAGE: ...] is subject-only — do not seed with
		// the character base image. Only [IMAGE_SELF: ...] references the base.
		const includeBase = isFullAccessActive() ? isSelfImage : true;
		const referencePath = includeBase ? (basePath ?? undefined) : undefined;

		// In full-access mode, base image is optional. When editing a user's image,
		// we don't need the character base either.
		if (isEdit || basePath || isFullAccessActive()) {
			try {
				await ctx.replyWithChatAction("upload_photo");
				if (isDev)
					console.log(
						`[image] ${isEdit ? "Edit" : "Generate"} prompt:`,
						extractedPrompt.slice(0, 300),
					);
				const imageBuffer = isEdit
					? await editImage(extractedPrompt, userImagePath as string)
					: await generateImage(extractedPrompt, referencePath);

				const filename = `${getBotName().toLowerCase()}.png`;
				await ctx.replyWithPhoto(new InputFile(imageBuffer, filename), {
					caption: responseText || undefined,
					...replyOptions,
				});
				imageSent = true;

				// User-initiated edits don't consume the weekly/photo quotas.
				if (!isEdit && shouldGenImage) {
					buffer.lastImageDate = getWeekStart();
					bufferDirty = true;
				}
				if (!isEdit && allowPhotoRequest) {
					buffer.allowPhotoRequest = false;
					bufferDirty = true;
				}
				if (bufferDirty) {
					await saveSensory(buffer);
				}
			} catch (error) {
				console.error("[image] Error generating image:", error);
				// Fall through to normal text reply
			}
		} else {
			console.warn("[image] No base image found, skipping image generation");
		}
	}

	// Send text reply if image wasn't sent (or had no caption)
	if (!imageSent) {
		if (isDev)
			console.log(
				"[TTS] Checking for marker:",
				ttsText ? `found "${ttsText}"` : "not found",
			);

		if (ttsText) {
			try {
				if (isDev) console.log("[TTS] Generating speech for:", ttsText);
				const audioPath = await textToSpeech(ttsText);
				if (isDev) console.log("[TTS] Audio saved to:", audioPath);
				await ctx.replyWithVoice(new InputFile(audioPath), replyOptions);
				if (showTranscription) {
					await ctx.reply(`📝 ${ttsText}`, replyOptions).catch(() => {});
				}
				// Cleanup TTS file after sending
				unlink(audioPath).catch(() => {});
			} catch (error) {
				console.error("[TTS] Error generating speech:", error);
				try {
					await ctx.reply(ttsText, replyOptions);
				} catch {
					// ignore fallback failure
				}
			}
		} else {
			try {
				await ctx.reply(responseText, {
					...replyOptions,
					parse_mode: "Markdown",
				});
			} catch {
				await ctx.reply(responseText, replyOptions);
			}
		}
	}

	return { cleanedText: responseText, bufferDirty };
}
