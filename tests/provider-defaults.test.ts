import { expect, test } from "bun:test";
import { CHAT_PROVIDERS, resolveChatModel } from "../src/provider-options.ts";

test("all chat providers resolve models from one metadata registry", () => {
	for (const provider of CHAT_PROVIDERS) {
		expect(resolveChatModel(provider.name, {})).toBe(provider.defaultModel);
		expect(
			resolveChatModel(provider.name, {
				[provider.modelEnv]: " selected-model ",
			}),
		).toBe("selected-model");
		expect(resolveChatModel(provider.name, { [provider.modelEnv]: " " })).toBe(
			provider.defaultModel,
		);
	}
});
