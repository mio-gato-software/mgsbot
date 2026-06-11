import {
	OpenAiCompatibleChatProvider,
	requireEnv,
} from "./openai-compatible.ts";

const isDev = process.env.NODE_ENV === "development";

interface FireworksVisionContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: {
		url: string;
	};
}

export class FireworksChatProvider extends OpenAiCompatibleChatProvider {
	constructor(model?: string) {
		super({
			name: "fireworks",
			errorLabel: "Fireworks",
			endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
			apiKey: requireEnv("FIREWORKS_API_KEY", "fireworks"),
			model:
				model ??
				process.env.FIREWORKS_MODEL ??
				"accounts/fireworks/models/glm-5",
			timeoutMs: 60_000,
			extraHeaders: {
				Accept: "application/json",
			},
			extraBody: {
				temperature: 0.6,
				top_p: 1,
				top_k: 40,
				presence_penalty: 0,
				frequency_penalty: 0,
			},
		});
	}

	async describeImage(
		imageBase64: string,
		mimeType: string,
		caption?: string,
	): Promise<string> {
		const prompt = caption
			? `The user sent this image with the caption: "${caption}". Describe what you see briefly so you can reference it in conversation.`
			: "The user sent this image. Describe what you see briefly so you can reference it in conversation.";

		const content: FireworksVisionContentPart[] = [
			{ type: "text", text: prompt },
			{
				type: "image_url",
				image_url: { url: `data:${mimeType};base64,${imageBase64}` },
			},
		];

		if (isDev) {
			console.log("[fireworks] describeImage using model", this.model);
		}

		const text = await this.chatCompletion(
			[{ role: "user", content }],
			":vision",
		);
		if (isDev) {
			console.log("[fireworks] describeImage result:", text.slice(0, 200));
		}
		return text;
	}
}
