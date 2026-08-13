import { GoogleGenAI } from "@google/genai";
import { alertOwner, errorSummary } from "../alerts.ts";
import { log } from "../logger.ts";
import { type ChatMessage, createChatProvider } from "../providers/index.ts";
import { withRetry } from "../utils.ts";
import { getOpenAIClient, openaiReasoningConfig } from "./openai-client.ts";
import {
	resolveBackgroundModel,
	resolveBackgroundProvider,
	resolveOpenAIBackgroundReasoningEffort,
	supportProviderHasKey,
} from "./platform.ts";

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
): Promise<string> {
	if (!backgroundAI) backgroundAI = new GoogleGenAI({});
	const response = await backgroundAI.models.generateContent({
		model,
		config: systemPrompt ? { systemInstruction: systemPrompt } : {},
		contents: messages.map((msg) => ({
			role: msg.role === "user" ? "user" : "model",
			parts: [{ text: msg.content }],
		})),
	});
	return response.text ?? "";
}

async function generateOpenAIBackgroundResponse(
	systemPrompt: string,
	messages: ChatMessage[],
	model: string,
): Promise<string> {
	const input = [
		{ role: "system" as const, content: systemPrompt },
		...messages.map((msg) => ({
			role: msg.role as "user" | "assistant",
			content: msg.content,
		})),
	];
	const response = await getOpenAIClient().responses.create({
		model,
		input,
		reasoning: openaiReasoningConfig(resolveOpenAIBackgroundReasoningEffort()),
	});
	return response.output_text ?? "";
}

export async function generateBackgroundResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	return (await generateBackgroundResponseWithModel(systemPrompt, messages))
		.text;
}

export async function generateBackgroundResponseWithModel(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<{ text: string; model: string }> {
	const provider = resolveBackgroundProvider();
	const model = backgroundModelId();

	if (supportProviderHasKey(provider)) {
		try {
			const text = await withRetry(
				async () =>
					provider === "openai"
						? generateOpenAIBackgroundResponse(systemPrompt, messages, model)
						: generateGeminiBackgroundResponse(systemPrompt, messages, model),
				2,
				500,
			);
			return { text, model: `${provider}:${model}` };
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
	return {
		text: await generateResponse(systemPrompt, messages),
		model: `${chat.name}:${chat.model}`,
	};
}
