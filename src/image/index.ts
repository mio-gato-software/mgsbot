import { FalImageProvider } from "./fal.ts";
import { GeminiImageProvider } from "./gemini.ts";
import type { ImageProvider } from "./types.ts";

export type { ImageProvider } from "./types.ts";

let cachedProvider: ImageProvider | null = null;

function createImageProvider(): ImageProvider {
	if (cachedProvider) return cachedProvider;

	const providerName = (process.env.IMAGE_PROVIDER || "gemini")
		.trim()
		.toLowerCase();

	switch (providerName) {
		case "fal":
			cachedProvider = new FalImageProvider();
			break;
		default:
			cachedProvider = new GeminiImageProvider();
			break;
	}

	console.log(`[image] Using provider: ${cachedProvider.name}`);
	return cachedProvider;
}

export function isImageGenAvailable(): boolean {
	return createImageProvider().isAvailable();
}

export async function generateImage(
	prompt: string,
	referenceImagePath?: string,
): Promise<Buffer> {
	return createImageProvider().generateImage(prompt, referenceImagePath);
}

export async function editImage(
	prompt: string,
	imagePath: string,
): Promise<Buffer> {
	return createImageProvider().editImage(prompt, imagePath);
}
