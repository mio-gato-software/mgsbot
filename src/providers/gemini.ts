import {
	type Content,
	type GenerateContentResponse,
	GoogleGenAI,
} from "@google/genai";
import { executeWeatherFunction, weatherTool } from "../weather.ts";
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
		.filter((msg) => msg.content?.trim())
		.map((msg) => ({
			role: msg.role === "user" ? "user" : "model",
			parts: [{ text: msg.content }],
		}));
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
		this.model = model ?? DEFAULT_MODEL;
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

		const response = await this.ai.models.generateContent({
			model: this.model,
			config: {
				systemInstruction: systemPrompt,
				tools: [{ functionDeclarations: [weatherTool] }],
			},
			contents,
		});
		logTokenUsage("generateResponse", response);

		const functionCalls = response.functionCalls;
		if (functionCalls && functionCalls.length > 0) {
			const call = functionCalls[0];
			if (call.name === "get_current_weather") {
				if (isDev) {
					console.log(
						"[GeminiChatProvider] Function call: get_current_weather",
					);
				}
				const weatherResult = await executeWeatherFunction();
				if (isDev) {
					console.log("[GeminiChatProvider] Weather result:", weatherResult);
				}

				const modelParts = response.candidates?.[0]?.content?.parts ?? [];
				const followUp: Content[] = [
					...contents,
					{
						role: "model",
						parts: modelParts,
					},
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									name: call.name,
									response: { result: weatherResult },
								},
							},
						],
					},
				];

				const followUpResponse = await this.ai.models.generateContent({
					model: this.model,
					config: {
						systemInstruction: systemPrompt,
						tools: [{ functionDeclarations: [weatherTool] }],
					},
					contents: followUp,
				});
				logTokenUsage("generateResponse:followUp", followUpResponse);
				const text = followUpResponse.text ?? "";
				if (isDev) {
					console.log(
						"[GeminiChatProvider] Follow-up response:",
						text.slice(0, 200),
					);
				}
				return text;
			}
		}

		const text = response.text ?? "";
		if (isDev) {
			console.log("[GeminiChatProvider] Response:", text.slice(0, 200));
		}
		return text;
	}
}
