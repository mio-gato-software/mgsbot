import { log } from "../logger.ts";
import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

interface FalResponse {
	output?: string;
	reasoning?: string;
	usage?: {
		cost?: number;
		prompt_tokens?: number;
		completion_tokens?: number;
	};
	error?: string;
	partial?: boolean;
}

export class FalChatProvider implements ChatProvider {
	readonly name: string = "fal";
	model: string;

	private readonly apiKey: string;

	constructor(model?: string, requiredFor = "CHAT_PROVIDER=fal") {
		const apiKey = process.env.FAL_API_KEY;
		if (!apiKey) {
			throw new Error(`FAL_API_KEY is required when ${requiredFor}`);
		}
		this.apiKey = apiKey;
		this.model = model ?? process.env.FAL_MODEL ?? "google/gemini-2.5-pro";
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const prompt = messages
			.map((msg) =>
				msg.role === "user"
					? `User: ${msg.content}`
					: `Assistant: ${msg.content}`,
			)
			.join("\n");

		log.debug(
			"[FalChatProvider] Calling model",
			this.model,
			"with",
			messages.length,
			"messages",
		);

		const data = await withRetry(async () => {
			const response = await fetch("https://fal.run/openrouter/router", {
				method: "POST",
				headers: {
					Authorization: `Key ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.model,
					system_prompt: systemPrompt,
					prompt,
					temperature: 0.7,
					reasoning: true,
				}),
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`fal.ai API error: ${response.status} ${response.statusText} ${errorBody}`,
				);
			}
			return (await response.json()) as FalResponse;
		});

		if (data.error) {
			throw new Error(`fal.ai model error: ${data.error}`);
		}

		if (data.usage) {
			log.debug(
				`[tokens:fal] in=${data.usage.prompt_tokens ?? 0} out=${data.usage.completion_tokens ?? 0} cost=${data.usage.cost ?? "?"}`,
			);
		}

		const text = data.output ?? "";
		log.debug("[FalChatProvider] Response:", text.slice(0, 200));
		return text;
	}
}

export class FalOpenRouterChatProvider extends FalChatProvider {
	override readonly name = "openrouter/fal";

	constructor(model?: string) {
		super(
			model ?? process.env.OPENROUTER_MODEL,
			"CHAT_PROVIDER=openrouter and OPENROUTER_TRANSPORT=fal",
		);
	}
}
