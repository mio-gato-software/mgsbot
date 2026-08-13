import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OPENAI_CHAT_MODEL,
	DEFAULT_OPENAI_EMBEDDING_MODEL,
	resolveAiPlatform,
	resolveBackgroundModel,
	resolveDefaultChatProviderName,
	resolveDefaultImageProviderName,
	resolveEmbeddingModel,
	resolveEmbeddingProvider,
	resolveOpenAIChatModel,
} from "../src/ai/platform.ts";
import { resolveImageProviderName } from "../src/provider-options.ts";

describe("AI platform", () => {
	test("defaults to gemini when Google is configured", () => {
		expect(resolveAiPlatform({ GOOGLE_API_KEY: "google" })).toBe("gemini");
	});

	test("defaults to openai when only OpenAI is configured", () => {
		expect(resolveAiPlatform({ OPENAI_API_KEY: "sk-test" })).toBe("openai");
	});

	test("honors an explicit AI_PLATFORM", () => {
		expect(
			resolveAiPlatform({
				AI_PLATFORM: "openai",
				GOOGLE_API_KEY: "google",
			}),
		).toBe("openai");
	});

	test("defaults chat and image providers from the platform", () => {
		const openaiOnly = { OPENAI_API_KEY: "sk-test" };
		expect(resolveDefaultChatProviderName(openaiOnly)).toBe("openai");
		expect(resolveDefaultImageProviderName(openaiOnly)).toBe("openai");
		expect(resolveImageProviderName(openaiOnly)).toBe("openai");
	});

	test("uses Luna and text-embedding-3-small on OpenAI", () => {
		const env = { OPENAI_API_KEY: "sk-test" };
		expect(resolveOpenAIChatModel(env)).toBe(DEFAULT_OPENAI_CHAT_MODEL);
		expect(resolveEmbeddingProvider(env)).toBe("openai");
		expect(resolveEmbeddingModel(env)).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
		expect(resolveBackgroundModel(env)).toBe("gpt-5.6-luna");
	});
});
