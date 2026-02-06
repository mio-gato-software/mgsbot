import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string;
}

interface AnthropicResponse {
	content: Array<{
		type: string;
		text: string;
	}>;
	usage?: {
		input_tokens: number;
		output_tokens: number;
	};
}

export class AnthropicChatProvider implements ChatProvider {
	readonly name = "anthropic";
	model: string;

	private readonly apiKey: string;

	constructor(model?: string) {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			throw new Error(
				"ANTHROPIC_API_KEY is required when CHAT_PROVIDER=anthropic",
			);
		}
		this.apiKey = apiKey;
		this.model =
			model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const anthropicMessages: AnthropicMessage[] = messages.map((msg) => ({
			role: msg.role,
			content: msg.content,
		}));

		if (isDev) {
			console.log(
				"[AnthropicChatProvider] Calling model",
				this.model,
				"with",
				anthropicMessages.length,
				"messages",
			);
		}

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: 4096,
				system: systemPrompt,
				messages: anthropicMessages,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(
				`Anthropic API error: ${response.status} ${response.statusText} ${errorBody}`,
			);
		}

		const data = (await response.json()) as AnthropicResponse;

		if (isDev && data.usage) {
			console.log(
				`[tokens:anthropic] in=${data.usage.input_tokens} out=${data.usage.output_tokens}`,
			);
		}

		const text = data.content?.[0]?.text ?? "";
		if (isDev) {
			console.log("[AnthropicChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}
}
