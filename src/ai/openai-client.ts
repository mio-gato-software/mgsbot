import OpenAI from "openai";
import { operationFetch, REQUEST_TIMEOUT_MS } from "../operation-deadline.ts";
import {
	type OpenAIReasoningEffort,
	openAIModelSupportsReasoning,
	resolveOpenAIReasoningEffort,
} from "./platform.ts";

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is required for OpenAI support paths");
	}
	if (!_client)
		_client = new OpenAI({
			apiKey,
			timeout: REQUEST_TIMEOUT_MS,
			maxRetries: 0,
			fetch: operationFetch,
		});
	return _client;
}

export function openaiReasoningConfig(
	model: string,
	effort: OpenAIReasoningEffort = resolveOpenAIReasoningEffort(),
): { reasoning?: { effort: OpenAIReasoningEffort } } {
	if (!openAIModelSupportsReasoning(model)) return {};
	return { reasoning: { effort } };
}
