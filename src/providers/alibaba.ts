import { resolveChatModel } from "../provider-options.ts";
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
			model: model ?? resolveChatModel("alibaba"),
			extraBody: {
				enable_thinking: true,
			},
		});
	}
}
