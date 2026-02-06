import type { ChatMessage, ChatProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface AzureMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface AzureResponse {
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

export class AzureChatProvider implements ChatProvider {
	readonly name = "azure";
	model: string;

	private readonly apiKey: string;
	private readonly endpoint: string;

	constructor(model?: string) {
		const apiKey = process.env.AZURE_API_KEY;
		if (!apiKey) {
			throw new Error("AZURE_API_KEY is required when CHAT_PROVIDER=azure");
		}
		const endpoint = process.env.AZURE_ENDPOINT;
		if (!endpoint) {
			throw new Error("AZURE_ENDPOINT is required when CHAT_PROVIDER=azure");
		}
		this.apiKey = apiKey;
		this.endpoint = endpoint;
		this.model = model ?? process.env.AZURE_MODEL ?? "Kimi-K2.5";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const azureMessages: AzureMessage[] = [
			{ role: "system", content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
				content: msg.content,
			})),
		];

		if (isDev) {
			console.log(
				"[AzureChatProvider] Calling model",
				this.model,
				"with",
				azureMessages.length,
				"messages",
			);
		}

		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				messages: azureMessages,
				max_tokens: 4096,
				temperature: 0.8,
				top_p: 0.1,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(
				`Azure API error: ${response.status} ${response.statusText} ${errorBody}`,
			);
		}

		const data = (await response.json()) as AzureResponse;

		if (isDev && data.usage) {
			console.log(
				`[tokens:azure] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} total=${data.usage.total_tokens}`,
			);
		}

		const text = data.choices?.[0]?.message?.content ?? "";
		if (isDev) {
			console.log("[AzureChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}
}
