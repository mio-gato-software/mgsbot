import * as fs from "node:fs";
import { toFile } from "openai";
import { getOpenAIClient } from "../ai/openai-client.ts";
import {
	resolveOpenAIImageModel,
	resolveOpenAIImageQuality,
	resolveOpenAIImageSize,
} from "../ai/platform.ts";
import { log } from "../logger.ts";
import {
	characterReferencePrompt,
	noImageText,
	userImageEditPrompt,
} from "./prompts.ts";
import type { ImageGenerationOptions, ImageProvider } from "./types.ts";

function mimeFromPath(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpg";
	return ext === "png" ? "image/png" : "image/jpeg";
}

async function bufferFromImageResponse(response: {
	data?: Array<{ b64_json?: string | null }>;
}): Promise<Buffer> {
	const b64 = response.data?.[0]?.b64_json;
	if (!b64) throw new Error("No image data in OpenAI response");
	return Buffer.from(b64, "base64");
}

export class OpenAIImageProvider implements ImageProvider {
	readonly name = "openai";

	isAvailable(): boolean {
		return !!process.env.OPENAI_API_KEY;
	}

	async generateImage(
		prompt: string,
		referenceImagePath?: string,
		options?: ImageGenerationOptions,
	): Promise<Buffer> {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error("OPENAI_API_KEY is required for OpenAI image generation");
		}

		const model = resolveOpenAIImageModel();
		const size = resolveOpenAIImageSize();
		const quality = resolveOpenAIImageQuality();
		log.debug("[image:openai] Prompt:", prompt.slice(0, 200));
		log.debug(
			"[image:openai] Model:",
			model,
			"size:",
			size,
			"quality:",
			quality,
		);

		if (referenceImagePath) {
			return this.requestImageEdit(
				`${characterReferencePrompt(prompt)} ${noImageText}`,
				referenceImagePath,
			);
		}

		const response = await getOpenAIClient().images.generate(
			{
				model,
				prompt: `Generate an image of: ${prompt}. ${options?.allowText ? "Render the requested text and numeric data accurately and legibly." : noImageText}`,
				size: size as "1024x1024",
				quality: quality as "high",
			},
			{ timeout: 300_000 },
		);
		log.debug("[image:openai] Image generated successfully");
		return bufferFromImageResponse(response);
	}

	async editImage(prompt: string, imagePath: string): Promise<Buffer> {
		log.debug("[image:openai:edit] Prompt:", prompt.slice(0, 200));
		return this.requestImageEdit(
			`${userImageEditPrompt(prompt)} ${noImageText}`,
			imagePath,
		);
	}

	private async requestImageEdit(
		prompt: string,
		imagePath: string,
	): Promise<Buffer> {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error("OPENAI_API_KEY is required for OpenAI image editing");
		}

		const model = resolveOpenAIImageModel();
		const size = resolveOpenAIImageSize();
		const quality = resolveOpenAIImageQuality();

		const image = await toFile(fs.createReadStream(imagePath), "image.png", {
			type: mimeFromPath(imagePath),
		});
		const response = await getOpenAIClient().images.edit(
			{
				model,
				image,
				prompt,
				size: size as "1024x1024",
				quality: quality as "high",
			},
			{ timeout: 300_000 },
		);
		log.debug("[image:openai:edit] Image edited successfully");
		return bufferFromImageResponse(response);
	}
}
