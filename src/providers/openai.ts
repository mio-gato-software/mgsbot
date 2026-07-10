import OpenAI from "openai";
import { describeImagePrompt } from "../ai/vision.ts";
import { log } from "../logger.ts";
import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

// Deliberately not extending OpenAiCompatibleChatProvider: this uses the
// OpenAI SDK's Responses API, not the chat-completions HTTP shape.
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

		log.debug(
			"[OpenAIChatProvider] Calling model",
			this.model,
			"with",
			messages.length,
			"messages",
		);

		const response = await withRetry(async () => {
			const res = await this.client.responses.create({
				model: this.model,
				input,
			});
			return res;
		});

		const text = response.output_text ?? "";

		if (response.usage) {
			log.debug(
				`[tokens:openai] in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
			);
		}
		log.debug("[OpenAIChatProvider] Response:", text.slice(0, 200));

		return text;
	}

	async describeImage(
		imageBase64: string,
		mimeType: string,
		caption?: string,
	): Promise<string> {
		const prompt = describeImagePrompt(caption);

		log.debug("[OpenAIChatProvider] describeImage using model", this.model);

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
								detail: "auto",
							},
						],
					},
				],
			});
			return res;
		});

		const text = response.output_text ?? "";
		log.debug("[OpenAIChatProvider] describeImage result:", text.slice(0, 200));
		return text;
	}
}
