import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface FireworksMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface FireworksVisionContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: {
		url: string;
	};
}

interface FireworksVisionMessage {
	role: "system" | "user" | "assistant";
	content: string | FireworksVisionContentPart[];
}

interface FireworksResponse {
	choices: Array<{
		message: {
			content: string;
		};
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export class FireworksChatProvider implements ChatProvider {
	readonly name = "fireworks";
	model: string;

	private readonly apiKey: string;

	constructor(model?: string) {
		const apiKey = process.env.FIREWORKS_API_KEY;
		if (!apiKey) {
			throw new Error(
				"FIREWORKS_API_KEY is required when CHAT_PROVIDER=fireworks",
			);
		}
		this.apiKey = apiKey;
		this.model =
			model ?? process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/glm-5";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const fireworksMessages: FireworksMessage[] = [
			{ role: "system", content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
				content: msg.content,
			})),
		];

		if (isDev) {
			console.log(
				"[FireworksChatProvider] Calling model",
				this.model,
				"with",
				fireworksMessages.length,
				"messages",
			);
		}

		const data = await withRetry(async () => {
			const response = await fetch(
				"https://api.fireworks.ai/inference/v1/chat/completions",
				{
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify({
						model: this.model,
						messages: fireworksMessages,
						temperature: 0.6,
						top_p: 1,
						top_k: 40,
						presence_penalty: 0,
						frequency_penalty: 0,
					}),
					signal: AbortSignal.timeout(60_000),
				},
			);
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`Fireworks API error: ${response.status} ${response.statusText} ${errorBody}`,
				);
			}
			return (await response.json()) as FireworksResponse;
		});

		if (isDev && data.usage) {
			console.log(
				`[tokens:fireworks] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} total=${data.usage.total_tokens}`,
			);
		}

		const text = data.choices?.[0]?.message?.content ?? "";
		if (isDev) {
			console.log("[FireworksChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}

	async describeImage(
		imageBase64: string,
		mimeType: string,
		caption?: string,
	): Promise<string> {
		const prompt = caption
			? `The user sent this image with the caption: "${caption}". Describe what you see briefly so you can reference it in conversation.`
			: "The user sent this image. Describe what you see briefly so you can reference it in conversation.";

		const messages: FireworksVisionMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: prompt,
					},
					{
						type: "image_url",
						image_url: {
							url: `data:${mimeType};base64,${imageBase64}`,
						},
					},
				],
			},
		];

		if (isDev) {
			console.log(
				"[FireworksChatProvider] describeImage using model",
				this.model,
			);
		}

		const data = await withRetry(async () => {
			const response = await fetch(
				"https://api.fireworks.ai/inference/v1/chat/completions",
				{
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify({
						model: this.model,
						messages,
						temperature: 0.6,
						top_p: 1,
						top_k: 40,
						presence_penalty: 0,
						frequency_penalty: 0,
					}),
					signal: AbortSignal.timeout(60_000),
				},
			);
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`Fireworks vision API error: ${response.status} ${response.statusText} ${errorBody}`,
				);
			}
			return (await response.json()) as FireworksResponse;
		});

		if (isDev && data.usage) {
			console.log(
				`[tokens:fireworks:vision] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} total=${data.usage.total_tokens}`,
			);
		}

		const text = data.choices?.[0]?.message?.content ?? "";
		if (isDev) {
			console.log(
				"[FireworksChatProvider] describeImage result:",
				text.slice(0, 200),
			);
		}
		return text;
	}
}
