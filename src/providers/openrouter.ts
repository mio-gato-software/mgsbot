import { resolveChatModel } from "../provider-options.ts";
import {
	OpenAiCompatibleChatProvider,
	requireEnv,
} from "./openai-compatible.ts";

export class OpenRouterChatProvider extends OpenAiCompatibleChatProvider {
	constructor(model?: string) {
		super({
			name: "openrouter",
			errorLabel: "OpenRouter",
			endpoint: "https://openrouter.ai/api/v1/chat/completions",
			apiKey: requireEnv("OPENROUTER_API_KEY", "openrouter"),
			model: model ?? resolveChatModel("openrouter"),
			extraHeaders: {
				"HTTP-Referer":
					process.env.OPENROUTER_HTTP_REFERER ??
					"https://github.com/eliaquin/mgsbot",
				"X-Title": process.env.OPENROUTER_TITLE ?? "MGS Bot",
			},
		});
	}
}
