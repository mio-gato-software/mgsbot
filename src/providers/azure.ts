import {
	OpenAiCompatibleChatProvider,
	requireEnv,
} from "./openai-compatible.ts";

export class AzureChatProvider extends OpenAiCompatibleChatProvider {
	constructor(model?: string) {
		super({
			name: "azure",
			errorLabel: "Azure",
			endpoint: requireEnv("AZURE_ENDPOINT", "azure"),
			apiKey: requireEnv("AZURE_API_KEY", "azure"),
			model: model ?? process.env.AZURE_MODEL ?? "Kimi-K2.5",
			extraBody: {
				max_tokens: 4096,
				temperature: 0.8,
				top_p: 0.1,
			},
		});
	}
}
