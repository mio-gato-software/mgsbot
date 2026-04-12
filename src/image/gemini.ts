import * as fs from "node:fs";
import { createUserContent, GoogleGenAI } from "@google/genai";
import type { ImageProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";
const hasGoogleApiKey = !!process.env.GOOGLE_API_KEY;

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}

export class GeminiImageProvider implements ImageProvider {
	readonly name = "gemini";

	isAvailable(): boolean {
		return hasGoogleApiKey;
	}

	async generateImage(
		prompt: string,
		referenceImagePath: string,
	): Promise<Buffer> {
		if (!hasGoogleApiKey) {
			throw new Error("GOOGLE_API_KEY is required for Gemini image generation");
		}
		if (isDev) console.log("[image:gemini] Prompt:", prompt.slice(0, 200));

		const ext = referenceImagePath.split(".").pop() ?? "jpg";
		const mimeType = ext === "png" ? "image/png" : "image/jpeg";
		const base64Data = fs.readFileSync(referenceImagePath, {
			encoding: "base64",
		});

		const response = await getAI().models.generateContentStream({
			model: "gemini-3-pro-image-preview",
			contents: createUserContent([
				{ inlineData: { mimeType, data: base64Data } },
				{
					text: `This is a reference image of a character in cartoon illustration style. Generate a new image of this same character (same face, body features) in the SAME cartoon/illustrated art style (flat colors, clean linework, digital illustration) but with a completely different outfit, pose, and setting. The scene: ${prompt}. The setting and atmosphere should feel natural for the described scene (e.g. indoor scenes like a bedroom, living room, restaurant, bar, mall, gym, or office should have appropriate indoor lighting; outdoor scenes like a beach, park, city street, rooftop, garden, or poolside should have appropriate natural lighting). IMPORTANT: Maintain the cartoon illustration style throughout. Do NOT render any text, clocks, timestamps, or time indicators in the image. Only the character's identity should match the reference — everything else should be new and fit the scene.`,
				},
			]),
			config: {
				imageConfig: {
					imageSize: "1K",
				},
				responseModalities: ["IMAGE", "TEXT"],
			},
		});

		for await (const chunk of response) {
			const parts = chunk.candidates?.[0]?.content?.parts;
			if (!parts) continue;
			for (const part of parts) {
				if (part.inlineData?.data) {
					if (isDev) console.log("[image:gemini] Image generated successfully");
					return Buffer.from(part.inlineData.data, "base64");
				}
			}
		}

		throw new Error("No image data in Gemini response");
	}

	async editImage(prompt: string, imagePath: string): Promise<Buffer> {
		if (!hasGoogleApiKey) {
			throw new Error("GOOGLE_API_KEY is required for Gemini image editing");
		}
		if (isDev) console.log("[image:gemini:edit] Prompt:", prompt.slice(0, 200));

		const ext = imagePath.split(".").pop() ?? "jpg";
		const mimeType = ext === "png" ? "image/png" : "image/jpeg";
		const base64Data = fs.readFileSync(imagePath, { encoding: "base64" });

		const response = await getAI().models.generateContentStream({
			model: "gemini-3-pro-image-preview",
			contents: createUserContent([
				{ inlineData: { mimeType, data: base64Data } },
				{
					text: `Edit this image according to the following instruction: ${prompt}. Preserve the overall composition and subject of the original image unless the instruction explicitly asks otherwise. Do NOT render any text, clocks, timestamps, or time indicators in the image.`,
				},
			]),
			config: {
				imageConfig: {
					imageSize: "1K",
				},
				responseModalities: ["IMAGE", "TEXT"],
			},
		});

		for await (const chunk of response) {
			const parts = chunk.candidates?.[0]?.content?.parts;
			if (!parts) continue;
			for (const part of parts) {
				if (part.inlineData?.data) {
					if (isDev)
						console.log("[image:gemini:edit] Image edited successfully");
					return Buffer.from(part.inlineData.data, "base64");
				}
			}
		}

		throw new Error("No image data in Gemini edit response");
	}
}
