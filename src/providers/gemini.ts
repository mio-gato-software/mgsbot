import {
	type Content,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";

import { withRetry } from "../utils.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

const DEFAULT_MODEL = "gemini-3-flash-preview";
const isDev = process.env.NODE_ENV === "development";

function logTokenUsage(label: string, response: GenerateContentResponse): void {
	const usage = response.usageMetadata;
	if (!usage) return;
	console.log(
		`[tokens:${label}] in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`,
	);
}

function messagesToContents(messages: ChatMessage[]): Content[] {
	return messages
		.filter((msg) => msg.content?.trim() || msg.mediaAttachment)
		.map((msg) => {
			const parts: Part[] = [];
			if (msg.content?.trim()) {
				parts.push({ text: msg.content });
			}
			if (msg.mediaAttachment) {
				parts.push({
					inlineData: {
						data: msg.mediaAttachment.data,
						mimeType: msg.mediaAttachment.mimeType,
					},
				});
			}
			return {
				role: msg.role === "user" ? "user" : "model",
				parts,
			};
		});
}

export class GeminiChatProvider implements ChatProvider {
	readonly name = "gemini";
	model: string;
	private readonly ai: GoogleGenAI;

	constructor(model?: string) {
		const apiKey = process.env.GOOGLE_API_KEY;
		if (!apiKey) {
			throw new Error(
				"GOOGLE_API_KEY is required when CHAT_PROVIDER=gemini (or unset)",
			);
		}
		this.ai = new GoogleGenAI({ apiKey });
		this.model = model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
	}

	async generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string> {
		const contents = messagesToContents(messages);

		if (contents.length === 0) {
			throw new Error(
				"No valid messages to send to Gemini API. The conversation history may be corrupted - please clear the chat memory.",
			);
		}

		if (isDev) {
			console.log(
				"[GeminiChatProvider] Calling model with",
				contents.length,
				"content entries",
			);
		}

		const response = await withRetry(() =>
			this.ai.models.generateContent({
				model: this.model,
				config: {
					systemInstruction: systemPrompt,
				},
				contents,
			}),
		);
		logTokenUsage("generateResponse", response);

		const text = response.text ?? "";
		if (isDev) {
			console.log("[GeminiChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}
}
