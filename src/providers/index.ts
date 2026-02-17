import { AlibabaChatProvider } from "./alibaba.ts";
import { AnthropicChatProvider } from "./anthropic.ts";
import { AzureChatProvider } from "./azure.ts";
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
		case "anthropic":
			cachedProvider = new AnthropicChatProvider();
			break;
		case "azure":
			cachedProvider = new AzureChatProvider();
			break;
		case "alibaba":
			cachedProvider = new AlibabaChatProvider();
			break;
		default:
			cachedProvider = new GeminiChatProvider();
			break;
	}

	console.log(`[chat] Using provider: ${cachedProvider.name}`);
	return cachedProvider;
}

export function switchChatProvider(
	providerName: string,
	model?: string,
): ChatProvider {
	switch (providerName) {
		case "openrouter":
			cachedProvider = model
				? new OpenRouterChatProvider(model)
				: new OpenRouterChatProvider();
			break;
		case "gemini":
			cachedProvider = model
				? new GeminiChatProvider(model)
				: new GeminiChatProvider();
			break;
		case "anthropic":
			cachedProvider = model
				? new AnthropicChatProvider(model)
				: new AnthropicChatProvider();
			break;
		case "azure":
			cachedProvider = model
				? new AzureChatProvider(model)
				: new AzureChatProvider();
			break;
		case "alibaba":
			cachedProvider = model
				? new AlibabaChatProvider(model)
				: new AlibabaChatProvider();
			break;
		default:
			throw new Error(`Unknown provider: ${providerName}`);
	}

	console.log(
		`[chat] Switched to provider: ${cachedProvider.name}, model: ${cachedProvider.model}`,
	);
	return cachedProvider;
}

export function getChatProviderInfo(): { provider: string; model: string } {
	const provider = createChatProvider();
	return { provider: provider.name, model: provider.model };
}
