import { GoogleGenAI } from "@google/genai";
import { alertOwner, errorSummary } from "../alerts.ts";
import { log } from "../logger.ts";
import { recordMemoryUsage, type TokenUsage } from "../memory/usage-metrics.ts";
import { type ChatMessage, createChatProvider } from "../providers/index.ts";
import { withRetry } from "../utils.ts";
import { getOpenAIClient, openaiReasoningConfig } from "./openai-client.ts";
import {
	resolveBackgroundModel,
	resolveBackgroundProvider,
	resolveOpenAIBackgroundReasoningEffort,
	supportProviderHasKey,
} from "./platform.ts";

interface BackgroundResult {
	text: string;
	usage: TokenUsage;
}

let backgroundAI: GoogleGenAI | null = null;
let warnedBackgroundFallback = false;

export async function generateResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	const provider = createChatProvider();
	try {
		return await provider.generateResponse(systemPrompt, messages);
	} catch (error) {
		await alertOwner(
			"chat-provider",
			`${provider.name} request failed: ${errorSummary(error)}`,
		);
		throw error;
	}
}

export function backgroundModelId(): string {
	return resolveBackgroundModel();
}

async function generateGeminiBackgroundResponse(
	systemPrompt: string,
	messages: ChatMessage[],
	model: string,
): Promise<BackgroundResult> {
	if (!backgroundAI) backgroundAI = new GoogleGenAI({});
	const response = await backgroundAI.models.generateContent({
		model,
		config: systemPrompt ? { systemInstruction: systemPrompt } : {},
		contents: messages.map((msg) => ({
			role: msg.role === "user" ? "user" : "model",
			parts: [{ text: msg.content }],
		})),
	});
	return {
		text: response.text ?? "",
		usage: {
			inputTokens: response.usageMetadata?.promptTokenCount,
			outputTokens: response.usageMetadata?.candidatesTokenCount,
			cachedInputTokens: response.usageMetadata?.cachedContentTokenCount,
			reasoningTokens: response.usageMetadata?.thoughtsTokenCount,
		},
	};
}

async function generateOpenAIBackgroundResponse(
	systemPrompt: string,
	messages: ChatMessage[],
	model: string,
): Promise<BackgroundResult> {
	const input = [
		...(systemPrompt
			? [{ role: "system" as const, content: systemPrompt }]
			: []),
		...messages.map((msg) => ({
			role: msg.role as "user" | "assistant",
			content: msg.content,
		})),
	];
	const response = await getOpenAIClient().responses.create({
		model,
		input,
		...openaiReasoningConfig(model, resolveOpenAIBackgroundReasoningEffort()),
	});
	return {
		text: response.output_text ?? "",
		usage: {
			inputTokens: response.usage?.input_tokens,
			outputTokens: response.usage?.output_tokens,
			cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens,
			reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens,
		},
	};
}

export async function generateBackgroundResponse(
	systemPrompt: string,
	messages: ChatMessage[],
	operation = "background",
): Promise<string> {
	return (
		await generateBackgroundResponseWithModel(systemPrompt, messages, operation)
	).text;
}

export async function generateBackgroundResponseWithModel(
	systemPrompt: string,
	messages: ChatMessage[],
	operation = "background",
): Promise<{ text: string; model: string }> {
	const provider = resolveBackgroundProvider();
	const model = backgroundModelId();
	const inputChars =
		systemPrompt.length +
		messages.reduce((sum, message) => sum + message.content.length, 0);

	if (supportProviderHasKey(provider)) {
		try {
			let attempt = 0;
			const result = await withRetry(
				async () => {
					attempt++;
					const start = Date.now();
					try {
						const result = await (provider === "openai"
							? generateOpenAIBackgroundResponse(systemPrompt, messages, model)
							: generateGeminiBackgroundResponse(
									systemPrompt,
									messages,
									model,
								));
						await recordMemoryUsage({
							operation,
							model: `${provider}:${model}`,
							status: "ok",
							attempt,
							inputChars,
							outputChars: result.text.length,
							durationMs: Date.now() - start,
							...result.usage,
						});
						return result;
					} catch (error) {
						await recordMemoryUsage({
							operation,
							model: `${provider}:${model}`,
							status: "error",
							attempt,
							inputChars,
							durationMs: Date.now() - start,
						});
						throw error;
					}
				},
				2,
				500,
			);
			return { text: result.text, model: `${provider}:${model}` };
		} catch (error) {
			log.warn(
				"[background-model] Background model failed, falling back to chat provider:",
				error,
			);
		}
	} else if (!warnedBackgroundFallback) {
		warnedBackgroundFallback = true;
		const missing = provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
		log.warn(
			`[background-model] ${missing} not set — background memory work will use the configured chat provider.`,
		);
	}

	const chat = createChatProvider();
	const start = Date.now();
	try {
		const text = await generateResponse(systemPrompt, messages);
		// The chat-provider interface exposes text only. Leave unavailable token counts unset.
		await recordMemoryUsage({
			operation,
			model: `${chat.name}:${chat.model}`,
			fallback: true,
			status: "ok",
			inputChars,
			outputChars: text.length,
			durationMs: Date.now() - start,
		});
		return { text, model: `${chat.name}:${chat.model}` };
	} catch (error) {
		await recordMemoryUsage({
			operation,
			model: `${chat.name}:${chat.model}`,
			fallback: true,
			status: "error",
			inputChars,
			durationMs: Date.now() - start,
		});
		throw error;
	}
}
