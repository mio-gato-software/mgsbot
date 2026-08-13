import * as fs from "node:fs";
import { toFile } from "openai";
import { getOpenAIClient } from "../ai/openai-client.ts";
import {
	resolveOpenAIImageModel,
	resolveOpenAIImageQuality,
	resolveOpenAIImageSize,
} from "../ai/platform.ts";
import { log } from "../logger.ts";
import type { ImageProvider } from "./types.ts";

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
			return this.editImage(
				`This is a reference image of a character in cartoon illustration style. Generate a new image of this same character (same face, body features) in the SAME cartoon/illustrated art style (flat colors, clean linework, digital illustration) but with a completely different outfit, pose, and setting. The scene: ${prompt}. The setting and atmosphere should feel natural for the described scene. IMPORTANT: Maintain the cartoon illustration style throughout. Do NOT render any text, clocks, timestamps, or time indicators in the image. Only the character's identity should match the reference — everything else should be new and fit the scene.`,
				referenceImagePath,
			);
		}

		const response = await getOpenAIClient().images.generate({
			model,
			prompt: `Generate an image of: ${prompt}. Do NOT render any text, clocks, timestamps, or time indicators in the image.`,
			size: size as "1024x1024",
			quality: quality as "high",
		});
		log.debug("[image:openai] Image generated successfully");
		return bufferFromImageResponse(response);
	}

	async editImage(prompt: string, imagePath: string): Promise<Buffer> {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error("OPENAI_API_KEY is required for OpenAI image editing");
		}

		const model = resolveOpenAIImageModel();
		const size = resolveOpenAIImageSize();
		const quality = resolveOpenAIImageQuality();
		log.debug("[image:openai:edit] Prompt:", prompt.slice(0, 200));

		const image = await toFile(fs.createReadStream(imagePath), "image.png", {
			type: mimeFromPath(imagePath),
		});
		const response = await getOpenAIClient().images.edit({
			model,
			image,
			prompt: `Edit this image according to the following instruction: ${prompt}. Preserve the overall composition and subject of the original image unless the instruction explicitly asks otherwise. Do NOT render any text, clocks, timestamps, or time indicators in the image.`,
			size: size as "1024x1024",
			quality: quality as "high",
		});
		log.debug("[image:openai:edit] Image edited successfully");
		return bufferFromImageResponse(response);
	}
}
