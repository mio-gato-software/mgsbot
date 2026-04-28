import * as fs from "node:fs";
import {
	FAL_IMAGE_MODELS,
	resolveFalImageModelName,
	resolveFalImageQuality,
} from "../provider-options.ts";
import { withRetry } from "../utils.ts";
import type { ImageProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";
const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

interface FalImageResponse {
	images?: Array<{
		url: string;
		content_type?: string;
	}>;
}

function resolveTimeoutMs(
	name: string,
	defaultValue: number,
	minValue: number,
): number {
	const raw = process.env[name]?.trim();
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
	return parsed;
}

export class FalImageProvider implements ImageProvider {
	readonly name = "fal";
	private readonly apiKey: string;
	private readonly modelName = resolveFalImageModelName();
	private readonly quality = resolveFalImageQuality();
	private readonly generationTimeoutMs = resolveTimeoutMs(
		"FAL_IMAGE_TIMEOUT_MS",
		DEFAULT_GENERATION_TIMEOUT_MS,
		30_000,
	);
	private readonly downloadTimeoutMs = resolveTimeoutMs(
		"FAL_IMAGE_DOWNLOAD_TIMEOUT_MS",
		DEFAULT_DOWNLOAD_TIMEOUT_MS,
		10_000,
	);

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

		const body: Record<string, unknown> = {
			prompt,
			quality: this.quality,
			num_images: 1,
			output_format: "png",
		};
		const model = FAL_IMAGE_MODELS.find(
			(candidate) => candidate.name === this.modelName,
		);
		if (!model) throw new Error(`Unknown fal image model: ${this.modelName}`);

		let endpoint: string;

		if (referenceImagePath) {
			const ext = referenceImagePath.split(".").pop() ?? "jpg";
			const mimeType = ext === "png" ? "image/png" : "image/jpeg";
			const base64Data = fs.readFileSync(referenceImagePath, {
				encoding: "base64",
			});
			body.image_urls = [`data:${mimeType};base64,${base64Data}`];
			endpoint = `https://fal.run/${model.editEndpoint}`;
		} else {
			endpoint = `https://fal.run/${model.textEndpoint}`;
		}

		if (isDev) {
			console.log("[image:fal] Model:", this.modelName);
			console.log("[image:fal] Quality:", this.quality);
			console.log("[image:fal] Endpoint:", endpoint);
		}

		const data = await withRetry(async () => {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Key ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.generationTimeoutMs),
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
			signal: AbortSignal.timeout(this.downloadTimeoutMs),
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
