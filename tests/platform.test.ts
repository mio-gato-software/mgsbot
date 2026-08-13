import { describe, expect, test } from "bun:test";
import {
	DEFAULT_GEMINI_BACKGROUND_MODEL,
	DEFAULT_GEMINI_CHAT_MODEL,
	DEFAULT_GEMINI_CLASSIFIER_MODEL,
	DEFAULT_GEMINI_DOCUMENT_MODEL,
	DEFAULT_GEMINI_EMBEDDING_DIM,
	DEFAULT_GEMINI_EMBEDDING_MODEL,
	DEFAULT_GEMINI_IMAGE_MODEL,
	DEFAULT_GEMINI_IMAGE_SIZE,
	DEFAULT_GEMINI_STT_MODEL,
	DEFAULT_GEMINI_VISION_MODEL,
	DEFAULT_OPENAI_BACKGROUND_MODEL,
	DEFAULT_OPENAI_CHAT_MODEL,
	DEFAULT_OPENAI_DOCUMENT_MODEL,
	DEFAULT_OPENAI_EMBEDDING_DIM,
	DEFAULT_OPENAI_EMBEDDING_MODEL,
	DEFAULT_OPENAI_IMAGE_MODEL,
	DEFAULT_OPENAI_IMAGE_QUALITY,
	DEFAULT_OPENAI_IMAGE_SIZE,
	DEFAULT_OPENAI_STT_MODEL,
	DEFAULT_OPENAI_TTS_MODEL,
	DEFAULT_OPENAI_TTS_VOICE,
	DEFAULT_OPENAI_VISION_MODEL,
	hasAnyAiKey,
	openAIModelSupportsReasoning,
	openaiClassifierMaxOutputTokens,
	resolveAiPlatform,
	resolveBackgroundModel,
	resolveBackgroundProvider,
	resolveClassifierModel,
	resolveClassifierProvider,
	resolveDefaultChatProviderName,
	resolveDefaultImageProviderName,
	resolveDocumentProvider,
	resolveEmbeddingDim,
	resolveEmbeddingModel,
	resolveEmbeddingProvider,
	resolveGeminiDocumentModel,
	resolveGeminiImageModel,
	resolveGeminiImageSize,
	resolveGeminiSttModel,
	resolveGeminiVisionModel,
	resolveOpenAIBackgroundReasoningEffort,
	resolveOpenAIChatModel,
	resolveOpenAIClassifierReasoningEffort,
	resolveOpenAIDocumentModel,
	resolveOpenAIImageModel,
	resolveOpenAIImageQuality,
	resolveOpenAIImageSize,
	resolveOpenAIReasoningEffort,
	resolveOpenAISttModel,
	resolveOpenAITtsModel,
	resolveOpenAITtsVoice,
	resolveOpenAIVisionModel,
	resolveVisionProvider,
	resolveYouTubeProvider,
	supportProviderHasKey,
} from "../src/ai/platform.ts";
import { resolveImageProviderName } from "../src/provider-options.ts";

describe("AI platform", () => {
	test("defaults to gemini when Google is configured", () => {
		expect(resolveAiPlatform({ GOOGLE_API_KEY: "google" })).toBe("gemini");
	});

	test("defaults to openai when only OpenAI is configured", () => {
		expect(resolveAiPlatform({ OPENAI_API_KEY: "sk-test" })).toBe("openai");
	});

	test("defaults to gemini when both keys are set", () => {
		expect(
			resolveAiPlatform({
				GOOGLE_API_KEY: "google",
				OPENAI_API_KEY: "sk-test",
			}),
		).toBe("gemini");
	});

	test("honors an explicit AI_PLATFORM", () => {
		expect(
			resolveAiPlatform({
				AI_PLATFORM: "openai",
				GOOGLE_API_KEY: "google",
			}),
		).toBe("openai");
	});

	test("treats blank AI_PLATFORM as unset", () => {
		expect(
			resolveAiPlatform({
				AI_PLATFORM: "   ",
				OPENAI_API_KEY: "sk-test",
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
		expect(resolveOpenAIChatModel(env)).toBe("gpt-5.6-luna");
		expect(resolveEmbeddingProvider(env)).toBe("openai");
		expect(resolveEmbeddingModel(env)).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
		expect(resolveBackgroundModel(env)).toBe(DEFAULT_OPENAI_BACKGROUND_MODEL);
	});
});

describe("independent support axes", () => {
	test("support providers follow AI_PLATFORM unless overridden", () => {
		const openaiOnly = { OPENAI_API_KEY: "sk-test" };
		expect(resolveEmbeddingProvider(openaiOnly)).toBe("openai");
		expect(resolveVisionProvider(openaiOnly)).toBe("openai");
		expect(resolveDocumentProvider(openaiOnly)).toBe("openai");
		expect(resolveBackgroundProvider(openaiOnly)).toBe("openai");
		expect(resolveClassifierProvider(openaiOnly)).toBe("openai");
	});

	test("can mix chat platform with a different embedding provider", () => {
		const env = {
			OPENAI_API_KEY: "sk-test",
			GOOGLE_API_KEY: "google",
			AI_PLATFORM: "openai",
			EMBEDDING_PROVIDER: "gemini",
		};
		expect(resolveAiPlatform(env)).toBe("openai");
		expect(resolveEmbeddingProvider(env)).toBe("gemini");
		expect(resolveEmbeddingModel(env)).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
		expect(resolveBackgroundProvider(env)).toBe("openai");
	});

	test("YouTube analysis stays on Gemini unless overridden", () => {
		expect(resolveYouTubeProvider({ OPENAI_API_KEY: "sk-test" })).toBe(
			"gemini",
		);
		expect(
			resolveYouTubeProvider({
				OPENAI_API_KEY: "sk-test",
				YOUTUBE_PROVIDER: "openai",
			}),
		).toBe("openai");
	});

	test("supportProviderHasKey checks the matching key", () => {
		expect(supportProviderHasKey("openai", { OPENAI_API_KEY: "sk" })).toBe(
			true,
		);
		expect(supportProviderHasKey("gemini", { OPENAI_API_KEY: "sk" })).toBe(
			false,
		);
		expect(supportProviderHasKey("gemini", { GOOGLE_API_KEY: "g" })).toBe(true);
		expect(hasAnyAiKey({ OPENAI_API_KEY: "sk" })).toBe(true);
		expect(hasAnyAiKey({})).toBe(false);
	});
});

describe("independent image models", () => {
	test("OpenAI image model is independent of the chat model", () => {
		const env = {
			OPENAI_MODEL: "gpt-5.6-sol",
			OPENAI_IMAGE_MODEL: "gpt-image-2",
		};
		expect(resolveOpenAIChatModel(env)).toBe("gpt-5.6-sol");
		expect(resolveOpenAIImageModel(env)).toBe("gpt-image-2");
		expect(resolveOpenAIImageModel({})).toBe(DEFAULT_OPENAI_IMAGE_MODEL);
	});

	test("Gemini image model is independent of the chat model", () => {
		const env = {
			GEMINI_MODEL: "gemini-3.1-pro-preview",
			GEMINI_IMAGE_MODEL: "gemini-3-pro-image",
		};
		expect(resolveGeminiImageModel(env)).toBe("gemini-3-pro-image");
		expect(resolveGeminiImageModel({})).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
		expect(resolveGeminiVisionModel(env)).toBe("gemini-3.1-pro-preview");
	});

	test("OpenAI and Gemini image size/quality are independently configurable", () => {
		expect(resolveOpenAIImageSize({})).toBe(DEFAULT_OPENAI_IMAGE_SIZE);
		expect(resolveOpenAIImageQuality({})).toBe(DEFAULT_OPENAI_IMAGE_QUALITY);
		expect(resolveGeminiImageSize({})).toBe(DEFAULT_GEMINI_IMAGE_SIZE);
		expect(resolveOpenAIImageSize({ OPENAI_IMAGE_SIZE: "1536x1024" })).toBe(
			"1536x1024",
		);
		expect(resolveOpenAIImageQuality({ OPENAI_IMAGE_QUALITY: "medium" })).toBe(
			"medium",
		);
		expect(resolveGeminiImageSize({ GEMINI_IMAGE_SIZE: "2K" })).toBe("2K");
	});
});

describe("model fallbacks", () => {
	test("OpenAI vision and documents fall back to OPENAI_MODEL then Luna", () => {
		expect(resolveOpenAIVisionModel({})).toBe(DEFAULT_OPENAI_VISION_MODEL);
		expect(resolveOpenAIDocumentModel({})).toBe(DEFAULT_OPENAI_DOCUMENT_MODEL);
		expect(resolveOpenAIVisionModel({ OPENAI_MODEL: "gpt-5.6-terra" })).toBe(
			"gpt-5.6-terra",
		);
		expect(
			resolveOpenAIVisionModel({
				OPENAI_MODEL: "gpt-5.6-terra",
				OPENAI_VISION_MODEL: "gpt-5.6-luna",
			}),
		).toBe("gpt-5.6-luna");
	});

	test("Gemini vision, documents, and STT fall back to GEMINI_MODEL", () => {
		expect(resolveGeminiVisionModel({})).toBe(DEFAULT_GEMINI_VISION_MODEL);
		expect(resolveGeminiDocumentModel({})).toBe(DEFAULT_GEMINI_DOCUMENT_MODEL);
		expect(resolveGeminiSttModel({})).toBe(DEFAULT_GEMINI_STT_MODEL);
		expect(
			resolveGeminiSttModel({ GEMINI_MODEL: "gemini-3.1-pro-preview" }),
		).toBe("gemini-3.1-pro-preview");
		expect(
			resolveGeminiSttModel({
				GEMINI_MODEL: "gemini-3.1-pro-preview",
				GEMINI_STT_MODEL: "gemini-3.6-flash",
			}),
		).toBe("gemini-3.6-flash");
	});

	test("OpenAI STT and TTS use their own defaults, not the chat model", () => {
		const env = { OPENAI_MODEL: "gpt-5.6-sol" };
		expect(resolveOpenAISttModel(env)).toBe(DEFAULT_OPENAI_STT_MODEL);
		expect(resolveOpenAITtsModel(env)).toBe(DEFAULT_OPENAI_TTS_MODEL);
		expect(resolveOpenAITtsVoice(env)).toBe(DEFAULT_OPENAI_TTS_VOICE);
		expect(resolveOpenAISttModel({ OPENAI_STT_MODEL: "whisper-1" })).toBe(
			"whisper-1",
		);
	});

	test("background and classifier models follow their providers", () => {
		expect(resolveBackgroundModel({ GOOGLE_API_KEY: "g" })).toBe(
			DEFAULT_GEMINI_BACKGROUND_MODEL,
		);
		expect(resolveClassifierModel({ GOOGLE_API_KEY: "g" })).toBe(
			DEFAULT_GEMINI_CLASSIFIER_MODEL,
		);
		expect(resolveBackgroundModel({ BACKGROUND_MODEL: "custom-bg" })).toBe(
			"custom-bg",
		);
		expect(
			resolveClassifierModel({
				OPENAI_API_KEY: "sk",
				CLASSIFIER_MODEL: "custom-clf",
			}),
		).toBe("custom-clf");
		expect(resolveOpenAIChatModel({})).toBe(DEFAULT_OPENAI_CHAT_MODEL);
		expect(resolveOpenAIChatModel({})).not.toBe(DEFAULT_GEMINI_CHAT_MODEL);
	});
});

describe("embedding configuration", () => {
	test("defaults to 768-d on both platforms", () => {
		expect(resolveEmbeddingDim({ OPENAI_API_KEY: "sk" })).toBe(
			DEFAULT_OPENAI_EMBEDDING_DIM,
		);
		expect(resolveEmbeddingDim({ GOOGLE_API_KEY: "g" })).toBe(
			DEFAULT_GEMINI_EMBEDDING_DIM,
		);
		expect(DEFAULT_OPENAI_EMBEDDING_DIM).toBe(768);
		expect(DEFAULT_GEMINI_EMBEDDING_DIM).toBe(768);
	});

	test("honors EMBEDDING_DIM and ignores invalid values", () => {
		expect(resolveEmbeddingDim({ EMBEDDING_DIM: "256" })).toBe(256);
		expect(resolveEmbeddingDim({ EMBEDDING_DIM: "nope" })).toBe(
			DEFAULT_GEMINI_EMBEDDING_DIM,
		);
		expect(resolveEmbeddingDim({ EMBEDDING_DIM: "0" })).toBe(
			DEFAULT_GEMINI_EMBEDDING_DIM,
		);
	});

	test("honors an explicit embedding model", () => {
		expect(
			resolveEmbeddingModel({
				OPENAI_API_KEY: "sk",
				EMBEDDING_MODEL: "text-embedding-3-large",
			}),
		).toBe("text-embedding-3-large");
	});
});

describe("OpenAI reasoning effort", () => {
	test("defaults to low and accepts valid values", () => {
		expect(resolveOpenAIReasoningEffort({})).toBe("low");
		expect(
			resolveOpenAIReasoningEffort({ OPENAI_REASONING_EFFORT: "none" }),
		).toBe("none");
		expect(
			resolveOpenAIReasoningEffort({ OPENAI_REASONING_EFFORT: "MAX" }),
		).toBe("max");
		expect(
			resolveOpenAIReasoningEffort({ OPENAI_REASONING_EFFORT: "nope" }),
		).toBe("low");
	});

	test("background effort falls back to the chat effort", () => {
		expect(
			resolveOpenAIBackgroundReasoningEffort({
				OPENAI_REASONING_EFFORT: "high",
			}),
		).toBe("high");
		expect(
			resolveOpenAIBackgroundReasoningEffort({
				OPENAI_REASONING_EFFORT: "high",
				OPENAI_BACKGROUND_REASONING_EFFORT: "none",
			}),
		).toBe("none");
	});

	test("classifier effort defaults to none", () => {
		expect(
			resolveOpenAIClassifierReasoningEffort({
				OPENAI_REASONING_EFFORT: "max",
			}),
		).toBe("none");
		expect(
			resolveOpenAIClassifierReasoningEffort({
				OPENAI_CLASSIFIER_REASONING_EFFORT: "low",
			}),
		).toBe("low");
	});

	test("only reasoning models receive the reasoning parameter", () => {
		expect(openAIModelSupportsReasoning("gpt-5.6-luna")).toBe(true);
		expect(openAIModelSupportsReasoning("gpt-4o")).toBe(false);
		expect(openAIModelSupportsReasoning("o3-mini")).toBe(true);
	});

	test("classifier token budgets honor the Responses API minimum", () => {
		expect(openaiClassifierMaxOutputTokens(5, "none")).toBe(16);
		expect(openaiClassifierMaxOutputTokens(5, "low")).toBe(64);
		expect(openaiClassifierMaxOutputTokens(80, "none")).toBe(80);
	});

	test("invalid OpenAI image size/quality fall back to defaults", () => {
		expect(resolveOpenAIImageSize({ OPENAI_IMAGE_SIZE: "4K" })).toBe(
			DEFAULT_OPENAI_IMAGE_SIZE,
		);
		expect(resolveOpenAIImageQuality({ OPENAI_IMAGE_QUALITY: "ultra" })).toBe(
			DEFAULT_OPENAI_IMAGE_QUALITY,
		);
	});
});
