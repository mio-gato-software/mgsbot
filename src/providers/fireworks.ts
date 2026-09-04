import { describeImagePrompt } from "../ai/vision.ts";
import { log } from "../logger.ts";
import { resolveChatModel } from "../provider-options.ts";
import {
	OpenAiCompatibleChatProvider,
	requireEnv,
} from "./openai-compatible.ts";

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
			model: model ?? resolveChatModel("fireworks"),
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
		const prompt = describeImagePrompt(caption);

		const content: FireworksVisionContentPart[] = [
			{ type: "text", text: prompt },
			{
				type: "image_url",
				image_url: { url: `data:${mimeType};base64,${imageBase64}` },
			},
		];

		log.debug("[fireworks] describeImage using model", this.model);

		const text = await this.chatCompletion(
			[{ role: "user", content }],
			":vision",
		);
		log.debug("[fireworks] describeImage result:", text.slice(0, 200));
		return text;
	}
}
