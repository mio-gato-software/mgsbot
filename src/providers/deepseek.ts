import OpenAI from "openai";
import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface DeepSeekMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface DeepSeekChatCompletionRequest {
	model: string;
	messages: DeepSeekMessage[];
	thinking: {
		type: "enabled";
	};
	reasoning_effort: "high";
	stream: false;
}

export class DeepSeekChatProvider implements ChatProvider {
	readonly name = "deepseek";
	model: string;

	private readonly client: OpenAI;

	constructor(model?: string) {
		const apiKey = process.env.DEEPSEEK_API_KEY;
		if (!apiKey) {
			throw new Error(
				"DEEPSEEK_API_KEY is required when CHAT_PROVIDER=deepseek",
			);
		}
		this.client = new OpenAI({
			baseURL: "https://api.deepseek.com",
			apiKey,
		});
		this.model = model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const deepSeekMessages: DeepSeekMessage[] = [
			{ role: "system", content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
				content: msg.content,
			})),
		];

		if (isDev) {
			console.log(
				"[DeepSeekChatProvider] Calling model",
				this.model,
				"with",
				deepSeekMessages.length,
				"messages",
			);
		}

		const response = await withRetry(async () => {
			const request: DeepSeekChatCompletionRequest = {
				model: this.model,
				messages: deepSeekMessages,
				thinking: { type: "enabled" },
				reasoning_effort: "high",
				stream: false,
			};

			return await this.client.chat.completions.create(
				request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
			);
		});

		const text = response.choices?.[0]?.message?.content ?? "";

		if (isDev) {
			if (response.usage) {
				console.log(
					`[tokens:deepseek] in=${response.usage.prompt_tokens} out=${response.usage.completion_tokens} total=${response.usage.total_tokens}`,
				);
			}
			console.log("[DeepSeekChatProvider] Response:", text.slice(0, 200));
		}

		return text;
	}
}
