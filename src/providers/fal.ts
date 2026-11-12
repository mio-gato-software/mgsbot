import { log } from "../logger.ts";
import { requestSignal } from "../operation-deadline.ts";
import { resolveChatModel } from "../provider-options.ts";
import { ResearchFailure } from "../research-failure.ts";
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

	constructor(
		model?: string,
		requiredFor = "CHAT_PROVIDER=fal",
		private readonly reasoning = true,
	) {
		const apiKey = process.env.FAL_API_KEY;
		if (!apiKey) {
			throw new Error(`FAL_API_KEY is required when ${requiredFor}`);
		}
		this.apiKey = apiKey;
		this.model = model ?? resolveChatModel("fal");
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		return (await this.generateResponseWithUsage(systemPrompt, messages)).text;
	}

	async generateResponseWithUsage(
		systemPrompt: string,
		messages: ChatMessage[],
	) {
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
					// A malformed surrogate from any upstream preview must not poison the request.
					system_prompt: systemPrompt.toWellFormed(),
					prompt: prompt.toWellFormed(),
					temperature: 0.7,
					reasoning: this.reasoning,
				}),
				signal: requestSignal(60_000),
			});
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw Object.assign(
					new Error(
						`fal.ai API error: ${response.status} ${response.statusText} ${errorBody}`,
					),
					{ status: response.status },
				);
			}
			const result = (await response.json()) as FalResponse;
			if (result.error)
				throw new ResearchFailure(
					"generation",
					`fal.ai model error: ${result.error}`,
				);
			if (!result.output?.trim() || result.partial)
				throw Object.assign(
					new ResearchFailure(
						"empty_response",
						`fal.ai returned empty or partial output for ${this.model}`,
					),
					{ status: 503 },
				);
			return result;
		});

		if (data.usage) {
			log.debug(
				`[tokens:fal] in=${data.usage.prompt_tokens ?? 0} out=${data.usage.completion_tokens ?? 0} cost=${data.usage.cost ?? "?"}`,
			);
		}

		const text = data.output ?? "";
		log.debug("[FalChatProvider] Response:", text.slice(0, 200));
		return {
			text,
			usage: {
				inputTokens: data.usage?.prompt_tokens,
				outputTokens: data.usage?.completion_tokens,
			},
		};
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
