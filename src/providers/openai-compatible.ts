import { alertOwner, errorSummary } from "../alerts.ts";
import { log } from "../logger.ts";
import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

export interface OpenAiCompatibleResponse {
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

export interface OpenAiCompatibleOptions {
	/** Provider name exposed via the ChatProvider interface and token logs */
	name: string;
	/** Human-readable label used in error messages (e.g. "OpenRouter") */
	errorLabel: string;
	endpoint: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
	extraHeaders?: Record<string, string>;
	/** Provider-specific body fields merged into every request */
	extraBody?: Record<string, unknown>;
}

export function requireEnv(varName: string, providerKey: string): string {
	const value = process.env[varName];
	if (!value) {
		throw new Error(`${varName} is required when CHAT_PROVIDER=${providerKey}`);
	}
	return value;
}

/**
 * Base class for providers that speak the OpenAI chat-completions wire format
 * over plain fetch (OpenRouter, Fireworks, Azure, DashScope, ...). Subclasses
 * only supply endpoint/credentials/defaults; request, retry, error handling,
 * and token logging live here.
 */
export class OpenAiCompatibleChatProvider implements ChatProvider {
	readonly name: string;
	model: string;

	private readonly errorLabel: string;
	private readonly endpoint: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly extraHeaders: Record<string, string>;
	private readonly extraBody: Record<string, unknown>;

	constructor(options: OpenAiCompatibleOptions) {
		this.name = options.name;
		this.errorLabel = options.errorLabel;
		this.endpoint = options.endpoint;
		this.apiKey = options.apiKey;
		this.model = options.model;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.extraHeaders = options.extraHeaders ?? {};
		this.extraBody = options.extraBody ?? {};
	}

	/**
	 * Run a chat-completions request with retry, error handling, and token
	 * logging. Message content is `unknown` so vision content parts work too.
	 */
	protected async chatCompletion(
		messages: Array<{ role: string; content: unknown }>,
		logContext = "",
	): Promise<string> {
		const data = await withRetry(async () => {
			return await this.fetchCompletion(messages, logContext);
		}).catch(async (error: unknown) => {
			// Retries exhausted: notify the owner (rate-limited), then rethrow
			await alertOwner(
				"chat-provider",
				`${this.errorLabel}${logContext} request failed after retries: ${errorSummary(error)}`,
			);
			throw error;
		});

		if (data.usage) {
			log.debug(
				`[tokens:${this.name}${logContext}] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} total=${data.usage.total_tokens}`,
			);
		}

		return data.choices?.[0]?.message?.content ?? "";
	}

	private async fetchCompletion(
		messages: Array<{ role: string; content: unknown }>,
		logContext: string,
	): Promise<OpenAiCompatibleResponse> {
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				...this.extraHeaders,
			},
			body: JSON.stringify({
				model: this.model,
				messages,
				...this.extraBody,
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(
				`${this.errorLabel}${logContext} API error: ${response.status} ${response.statusText} ${errorBody}`,
			);
		}
		return (await response.json()) as OpenAiCompatibleResponse;
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const converted = [
			{ role: "system", content: systemPrompt },
			...messages.map((msg) => ({
				role: msg.role === "user" ? "user" : "assistant",
				content: msg.content,
			})),
		];

		log.debug(
			`[${this.name}] Calling model`,
			this.model,
			"with",
			converted.length,
			"messages",
		);

		const text = await this.chatCompletion(converted);
		log.debug(`[${this.name}] Response:`, text.slice(0, 200));
		return text;
	}
}
