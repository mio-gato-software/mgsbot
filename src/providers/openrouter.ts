import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface OpenRouterMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OpenRouterResponse {
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

export class OpenRouterChatProvider implements ChatProvider {
	readonly name = "openrouter";
	model: string;

	private readonly apiKey: string;

	constructor(model?: string) {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error(
				"OPENROUTER_API_KEY is required when CHAT_PROVIDER=openrouter",
			);
		}
		this.apiKey = apiKey;
		this.model =
			model ?? process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const openRouterMessages: OpenRouterMessage[] = [
			{ role: "system", content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
				content: msg.content,
			})),
		];

		if (isDev) {
			console.log(
				"[OpenRouterChatProvider] Calling model",
				this.model,
				"with",
				openRouterMessages.length,
				"messages",
			);
		}

		const data = await withRetry(async () => {
			const response = await fetch(
				"https://openrouter.ai/api/v1/chat/completions",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						"Content-Type": "application/json",
						"HTTP-Referer":
							process.env.OPENROUTER_HTTP_REFERER ??
							"https://github.com/eliaquinencarnacion/mgsbot",
						"X-Title": process.env.OPENROUTER_TITLE ?? "MGS Bot",
					},
					body: JSON.stringify({
						model: this.model,
						messages: openRouterMessages,
					}),
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`OpenRouter API error: ${response.status} ${response.statusText} ${errorBody}`,
				);
			}
			return (await response.json()) as OpenRouterResponse;
		});

		if (isDev && data.usage) {
			console.log(
				`[tokens:openrouter] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} total=${data.usage.total_tokens}`,
			);
		}

		const text = data.choices?.[0]?.message?.content ?? "";
		if (isDev) {
			console.log("[OpenRouterChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}
}
