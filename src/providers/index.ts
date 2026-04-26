import {
	type ChatProviderName,
	isChatProviderName,
	resolveChatProviderName,
} from "../provider-options.ts";
import { AlibabaChatProvider } from "./alibaba.ts";
import { AnthropicChatProvider } from "./anthropic.ts";
import { AzureChatProvider } from "./azure.ts";
import { DeepSeekChatProvider } from "./deepseek.ts";
import { FalChatProvider } from "./fal.ts";
import { FireworksChatProvider } from "./fireworks.ts";
import { GeminiChatProvider } from "./gemini.ts";
import { OpenAIChatProvider } from "./openai.ts";
import { OpenRouterChatProvider } from "./openrouter.ts";
import type { ChatProvider } from "./types.ts";

export type { ChatMessage, ChatProvider } from "./types.ts";

let cachedProvider: ChatProvider | null = null;

export function createChatProvider(): ChatProvider {
	if (cachedProvider) {
		return cachedProvider;
	}

	const providerName = resolveChatProviderName();

	cachedProvider = buildChatProvider(providerName);

	console.log(`[chat] Using provider: ${cachedProvider.name}`);
	return cachedProvider;
}

function buildChatProvider(
	providerName: ChatProviderName,
	model?: string,
): ChatProvider {
	switch (providerName) {
		case "openrouter":
			return model
				? new OpenRouterChatProvider(model)
				: new OpenRouterChatProvider();
		case "anthropic":
			return model
				? new AnthropicChatProvider(model)
				: new AnthropicChatProvider();
		case "azure":
			return model ? new AzureChatProvider(model) : new AzureChatProvider();
		case "alibaba":
			return model ? new AlibabaChatProvider(model) : new AlibabaChatProvider();
		case "fireworks":
			return model
				? new FireworksChatProvider(model)
				: new FireworksChatProvider();
		case "openai":
			return model ? new OpenAIChatProvider(model) : new OpenAIChatProvider();
		case "deepseek":
			return model
				? new DeepSeekChatProvider(model)
				: new DeepSeekChatProvider();
		case "fal":
			return model ? new FalChatProvider(model) : new FalChatProvider();
		case "gemini":
			return model ? new GeminiChatProvider(model) : new GeminiChatProvider();
	}
}

export function switchChatProvider(
	providerName: string,
	model?: string,
): ChatProvider {
	const normalized = providerName.trim().toLowerCase();
	if (!isChatProviderName(normalized)) {
		throw new Error(`Unknown provider: ${providerName}`);
	}
	cachedProvider = buildChatProvider(normalized, model);

	console.log(
		`[chat] Switched to provider: ${cachedProvider.name}, model: ${cachedProvider.model}`,
	);
	return cachedProvider;
}

export function getChatProviderInfo(): { provider: string; model: string } {
	const provider = createChatProvider();
	return { provider: provider.name, model: provider.model };
}
