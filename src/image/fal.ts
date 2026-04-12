import * as fs from "node:fs";
import { withRetry } from "../utils.ts";
import type { ImageProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface FalImageResponse {
	images?: Array<{
		url: string;
		content_type?: string;
	}>;
}

export class FalImageProvider implements ImageProvider {
	readonly name = "fal";
	private readonly apiKey: string;

	constructor() {
		const apiKey = process.env.FAL_API_KEY;
		if (!apiKey) {
			throw new Error("FAL_API_KEY is required for fal image generation");
		}
		this.apiKey = apiKey;
	}

	isAvailable(): boolean {
		return !!process.env.FAL_API_KEY;
	}

	async generateImage(
		prompt: string,
		referenceImagePath?: string,
	): Promise<Buffer> {
		if (isDev) console.log("[image:fal] Prompt:", prompt.slice(0, 200));

		// Use /edit endpoint with reference image, or base endpoint for text-to-image
		const body: Record<string, unknown> = {
			prompt,
			num_images: 1,
			output_format: "png",
		};

		let endpoint: string;

		if (referenceImagePath) {
			const ext = referenceImagePath.split(".").pop() ?? "jpg";
			const mimeType = ext === "png" ? "image/png" : "image/jpeg";
			const base64Data = fs.readFileSync(referenceImagePath, {
				encoding: "base64",
			});
			body.image_urls = [`data:${mimeType};base64,${base64Data}`];
			endpoint = "https://fal.run/fal-ai/nano-banana-pro/edit";
		} else {
			endpoint = "https://fal.run/fal-ai/nano-banana-pro";
		}

		if (isDev) console.log("[image:fal] Endpoint:", endpoint);

		const data = await withRetry(async () => {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Key ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`fal.ai image error: ${response.status} ${response.statusText} ${errorBody}`,
				);
			}
			return (await response.json()) as FalImageResponse;
		});

		const imageUrl = data.images?.[0]?.url;
		if (!imageUrl) {
			throw new Error("No image URL in fal.ai response");
		}

		// Download the generated image
		const imageResponse = await fetch(imageUrl, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!imageResponse.ok) {
			throw new Error(
				`Failed to download fal.ai image: ${imageResponse.status}`,
			);
		}

		if (isDev) console.log("[image:fal] Image generated successfully");
		return Buffer.from(await imageResponse.arrayBuffer());
	}

	async editImage(prompt: string, imagePath: string): Promise<Buffer> {
		// fal.ai's /edit endpoint handles editing natively; just forward.
		return this.generateImage(prompt, imagePath);
	}
}
