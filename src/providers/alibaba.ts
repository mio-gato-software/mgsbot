import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface DashScopeMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface DashScopeResponse {
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

export class AlibabaChatProvider implements ChatProvider {
	readonly name = "alibaba";
	model: string;

	private readonly apiKey: string;

	constructor(model?: string) {
		const apiKey = process.env.DASHSCOPE_API_KEY;
		if (!apiKey) {
			throw new Error(
				"DASHSCOPE_API_KEY is required when CHAT_PROVIDER=alibaba",
			);
		}
		this.apiKey = apiKey;
		this.model = model ?? process.env.DASHSCOPE_MODEL ?? "qwen3.5-plus";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const dashScopeMessages: DashScopeMessage[] = [
			{ role: "system", content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
				content: msg.content,
			})),
		];

		if (isDev) {
			console.log(
				"[AlibabaChatProvider] Calling model",
				this.model,
				"with",
				dashScopeMessages.length,
				"messages",
			);
		}

		const data = await withRetry(async () => {
			const response = await fetch(
				"https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: this.model,
						messages: dashScopeMessages,
						enable_thinking: true,
					}),
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`DashScope API error: ${response.status} ${response.statusText} ${errorBody}`,
				);
			}
			return (await response.json()) as DashScopeResponse;
		});

		if (isDev && data.usage) {
			console.log(
				`[tokens:alibaba] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} total=${data.usage.total_tokens}`,
			);
		}

		const text = data.choices?.[0]?.message?.content ?? "";
		if (isDev) {
			console.log("[AlibabaChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}
}
