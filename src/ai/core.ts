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
// Pinned to an explicit version rather than the `gemini-flash-latest` alias:
// extraction quality is measured per model (see memory/promotion-metrics.ts),
// and an alias that silently moves under the bot makes a quality shift
// impossible to attribute.
const DEFAULT_BACKGROUND_MODEL = "gemini-3.6-flash";

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

/** Model id background work will try first. */
export function backgroundModelId(): string {
	return process.env.BACKGROUND_MODEL || DEFAULT_BACKGROUND_MODEL;
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
	return (await generateBackgroundResponseWithModel(systemPrompt, messages))
		.text;
}

/**
 * Same as `generateBackgroundResponse`, but also reports which model actually
 * served the request. Callers that track extraction quality need to know
 * whether they got the cheap background model or the chat-provider fallback —
 * a quality shift is only interpretable next to the model that produced it.
 */
export async function generateBackgroundResponseWithModel(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<{ text: string; model: string }> {
	if (process.env.GOOGLE_API_KEY) {
		const model = backgroundModelId();
		try {
			const text = await withRetry(
				async () => {
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
				},
				2,
				500,
			);
			return { text, model };
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
	const provider = createChatProvider();
	return {
		text: await generateResponse(systemPrompt, messages),
		model: `${provider.name}:${provider.model}`,
	};
}
