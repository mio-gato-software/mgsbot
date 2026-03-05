import OpenAI from "openai";
import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

export class OpenAIChatProvider implements ChatProvider {
	readonly name = "openai";
	model: string;

	private readonly client: OpenAI;

	constructor(model?: string) {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY is required when CHAT_PROVIDER=openai");
		}
		this.client = new OpenAI({ apiKey });
		this.model = model ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const input = [
			{ role: "system" as const, content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role as "user" | "assistant",
				content: msg.content,
			})),
		];

		if (isDev) {
			console.log(
				"[OpenAIChatProvider] Calling model",
				this.model,
				"with",
				messages.length,
				"messages",
			);
		}

		const response = await withRetry(async () => {
			const res = await this.client.responses.create({
				model: this.model,
				input,
			});
			return res;
		});

		const text = response.output_text ?? "";

		if (isDev) {
			if (response.usage) {
				console.log(
					`[tokens:openai] in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
				);
			}
			console.log("[OpenAIChatProvider] Response:", text.slice(0, 200));
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

		if (isDev) {
			console.log("[OpenAIChatProvider] describeImage using model", this.model);
		}

		const response = await withRetry(async () => {
			const res = await this.client.responses.create({
				model: this.model,
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: prompt },
							{
								type: "input_image",
								image_url: `data:${mimeType};base64,${imageBase64}`,
							},
						],
					},
				],
			});
			return res;
		});

		const text = response.output_text ?? "";
		if (isDev) {
			console.log(
				"[OpenAIChatProvider] describeImage result:",
				text.slice(0, 200),
			);
		}
		return text;
	}
}
