import {
	OpenAiCompatibleChatProvider,
	requireEnv,
} from "./openai-compatible.ts";

export class AlibabaChatProvider extends OpenAiCompatibleChatProvider {
	constructor(model?: string) {
		super({
			name: "alibaba",
			errorLabel: "DashScope",
			endpoint:
				"https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
			apiKey: requireEnv("DASHSCOPE_API_KEY", "alibaba"),
			model: model ?? process.env.DASHSCOPE_MODEL ?? "qwen3.5-plus",
			extraBody: {
				enable_thinking: true,
			},
		});
	}
}
