import OpenAI from "openai";
import { log } from "../logger.ts";
import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

interface DeepSeekMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

// DeepSeek extends the OpenAI wire format with a `thinking` field the SDK does not model.
type DeepSeekChatCompletionRequest =
	OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
		thinking: {
			type: "enabled";
		};
	};

// Deliberately not extending OpenAiCompatibleChatProvider: this uses the
// OpenAI SDK client to send DeepSeek's thinking/reasoning_effort body.
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

		log.debug(
			"[DeepSeekChatProvider] Calling model",
			this.model,
			"with",
			deepSeekMessages.length,
			"messages",
		);

		const response = await withRetry(async () => {
			const request: DeepSeekChatCompletionRequest = {
				model: this.model,
				messages: deepSeekMessages,
				thinking: { type: "enabled" },
				reasoning_effort: "high",
				stream: false,
			};

			// Widen to the SDK param type: `thinking` is a DeepSeek-only extension field.
			return await this.client.chat.completions.create(
				request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
			);
		});

		const text = response.choices?.[0]?.message?.content ?? "";

		if (response.usage) {
			log.debug(
				`[tokens:deepseek] in=${response.usage.prompt_tokens} out=${response.usage.completion_tokens} total=${response.usage.total_tokens}`,
			);
		}
		log.debug("[DeepSeekChatProvider] Response:", text.slice(0, 200));

		return text;
	}
}
