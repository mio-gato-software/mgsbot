import { unlink } from "node:fs/promises";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import { generateImage, textToSpeech } from "./ai.ts";
import { getBaseImagePath } from "./appearance.ts";
import { getBotName } from "./config.ts";
import { getWeekStart } from "./image-scheduler.ts";
import { saveSensory } from "./memory.ts";
import { isSimpleAssistantMode } from "./prompt.ts";
import type { SensoryBuffer } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

export const IMAGE_MARKER_REGEX = /\[IMAGE:\s*([^\]]+)\]/;
export const REACTION_MARKER_REGEX = /\[REACT:\s*([^\]]+)\]/;
export const SILENCE_MARKER = "[SILENCE]";

export interface SendResponseOptions {
	ctx: Context;
	responseText: string;
	shouldGenImage: boolean;
	allowPhotoRequest: boolean;
	buffer: SensoryBuffer;
	isGroup: boolean;
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
	const { ctx, shouldGenImage, allowPhotoRequest, buffer, isGroup } = options;
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

	// Check for image marker
	const canGenerateImage = shouldGenImage || allowPhotoRequest;
	const imageMatch = canGenerateImage
		? responseText.match(IMAGE_MARKER_REGEX)
		: null;
	if (!canGenerateImage) {
		responseText = responseText.replace(IMAGE_MARKER_REGEX, "").trim();
	}
	let imageSent = false;
	let bufferDirty = false;

	if (imageMatch) {
		const extractedPrompt = imageMatch[1].trim();
		responseText = responseText.replace(IMAGE_MARKER_REGEX, "").trim();
		const basePath = getBaseImagePath();

		if (basePath) {
			try {
				await ctx.replyWithChatAction("upload_photo");
				if (isDev)
					console.log("[image] Prompt:", extractedPrompt.slice(0, 300));
				const imageBuffer = await generateImage(extractedPrompt, basePath);

				const filename = `${getBotName().toLowerCase()}.png`;
				await ctx.replyWithPhoto(new InputFile(imageBuffer, filename), {
					caption: responseText || undefined,
					...replyOptions,
				});
				imageSent = true;

				if (shouldGenImage) {
					buffer.lastImageDate = getWeekStart();
					bufferDirty = true;
				}
				if (allowPhotoRequest) {
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
		// TTS is disabled in simple assistant mode
		const TTS_REGEX = /\[TTS\]([\s\S]+?)\[\/TTS\]/;
		const ttsMatch = isSimpleAssistantMode
			? null
			: responseText.match(TTS_REGEX);

		if (isDev)
			console.log(
				"[TTS] Checking for marker:",
				ttsMatch ? `found "${ttsMatch[1]}"` : "not found",
			);

		if (ttsMatch) {
			const ttsText = ttsMatch[1].trim();
			// Strip TTS markers from saved text
			responseText = responseText.replace(TTS_REGEX, ttsText);

			try {
				if (isDev) console.log("[TTS] Generating speech for:", ttsText);
				const audioPath = await textToSpeech(ttsText);
				if (isDev) console.log("[TTS] Audio saved to:", audioPath);
				await ctx.replyWithVoice(new InputFile(audioPath), replyOptions);
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
