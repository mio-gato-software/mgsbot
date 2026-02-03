import { GeminiChatProvider } from "./gemini.ts";
import { OpenRouterChatProvider } from "./openrouter.ts";
import type { ChatProvider } from "./types.ts";

export type { ChatMessage, ChatProvider } from "./types.ts";

let cachedProvider: ChatProvider | null = null;

export function createChatProvider(): ChatProvider {
	if (cachedProvider) {
		return cachedProvider;
	}

	const providerName = process.env.CHAT_PROVIDER ?? "gemini";

	switch (providerName) {
		case "openrouter":
			cachedProvider = new OpenRouterChatProvider();
			break;
		default:
			cachedProvider = new GeminiChatProvider();
			break;
	}

	console.log(`[chat] Using provider: ${cachedProvider.name}`);
	return cachedProvider;
}
