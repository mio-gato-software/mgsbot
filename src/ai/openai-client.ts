import OpenAI from "openai";
import {
	type OpenAIReasoningEffort,
	resolveOpenAIReasoningEffort,
} from "./platform.ts";

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is required for OpenAI support paths");
	}
	if (!_client) _client = new OpenAI({ apiKey });
	return _client;
}

export function openaiReasoningConfig(
	effort: OpenAIReasoningEffort = resolveOpenAIReasoningEffort(),
): { effort: OpenAIReasoningEffort } {
	return { effort };
}
