import { GoogleGenAI } from "@google/genai";
import { alertOwner, errorSummary } from "../alerts.ts";
import { log } from "../logger.ts";
import { type ChatMessage, createChatProvider } from "../providers/index.ts";
import { withRetry } from "../utils.ts";

// Background memory work (fact extraction, narrative updates, janitor passes)
// is structured-JSON output and doesn't need a frontier model. Pin it to a
// cheap Gemini model so its cost stays capped regardless of the chat provider
// selected via /provider. Full flash (not lite): multi-field JSON extraction
// is beyond the yes/no routing the lite classifiers handle.
const DEFAULT_BACKGROUND_MODEL = "gemini-flash-latest";

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

/**
 * Generate a response for background (non-user-facing) work on the pinned
 * cheap model. Falls back to the configured chat provider when
 * GOOGLE_API_KEY is missing or the background model call fails.
 */
export async function generateBackgroundResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	if (process.env.GOOGLE_API_KEY) {
		try {
			return await withRetry(
				async () => {
					if (!backgroundAI) backgroundAI = new GoogleGenAI({});
					const response = await backgroundAI.models.generateContent({
						model: process.env.BACKGROUND_MODEL || DEFAULT_BACKGROUND_MODEL,
						config: systemPrompt ? { systemInstruction: systemPrompt } : {},
						contents: messages.map((msg) => ({
							role: msg.role === "user" ? "user" : "model",
							parts: [{ text: msg.content }],
						})),
					});
					return response.text ?? "";
				},
				2,
				500,
			);
		} catch (error) {
			log.warn(
				"[background-model] Background model failed, falling back to chat provider:",
				error,
			);
		}
	} else if (!warnedBackgroundFallback) {
		warnedBackgroundFallback = true;
		log.warn(
			"[background-model] GOOGLE_API_KEY not set — background memory work will use the configured chat provider.",
		);
	}
	return generateResponse(systemPrompt, messages);
}
