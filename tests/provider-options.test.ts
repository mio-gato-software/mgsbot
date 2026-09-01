import { describe, expect, test } from "bun:test";
import {
	findEnvCaseMismatches,
	formatProviderCommandStatus,
	formatProviderConfigurationFailure,
	formatProviderStartupSummary,
	isImageProviderName,
	isSttProviderName,
	isTtsProviderName,
	resolveChatProviderName,
	resolveFalImageModelName,
	resolveFalImageQuality,
	resolveImageProviderName,
	resolveOpenRouterTransport,
	resolveSttProviderOrder,
	resolveTtsProviderName,
	validateProviderConfiguration,
} from "../src/provider-options.ts";

describe("provider options", () => {
	test("defaults chat provider to gemini when no keys are set", () => {
		expect(resolveChatProviderName({})).toBe("gemini");
	});

	test("defaults chat provider to openai when only OpenAI is configured", () => {
		expect(resolveChatProviderName({ OPENAI_API_KEY: "sk-test" })).toBe(
			"openai",
		);
	});

	test("rejects unknown chat providers", () => {
		expect(() => resolveChatProviderName({ CHAT_PROVIDER: "typo" })).toThrow(
			"CHAT_PROVIDER",
		);
	});

	test("accepts deepseek as a chat provider", () => {
		expect(resolveChatProviderName({ CHAT_PROVIDER: "deepseek" })).toBe(
			"deepseek",
		);
	});

	test("OpenRouter transport can use fal when no OpenRouter key is set", () => {
		expect(resolveOpenRouterTransport({ FAL_API_KEY: "fal" })).toBe("fal");
		expect(
			validateProviderConfiguration({
				CHAT_PROVIDER: "openrouter",
				FAL_API_KEY: "fal",
				GOOGLE_API_KEY: "google",
			}).errors,
		).toEqual([]);
	});

	test("OpenRouter direct transport still requires an OpenRouter key", () => {
		const result = validateProviderConfiguration({
			CHAT_PROVIDER: "openrouter",
			OPENROUTER_TRANSPORT: "direct",
			FAL_API_KEY: "fal",
		});
		expect(result.errors).toContain(
			"OpenRouter chat requires OPENROUTER_API_KEY, or FAL_API_KEY with OPENROUTER_TRANSPORT=fal, when CHAT_PROVIDER=openrouter.",
		);
	});

	test("defaults fal image model to Nano Banana Pro", () => {
		expect(resolveFalImageModelName({})).toBe("nano-banana-pro");
	});

	test("defaults fal image quality to high", () => {
		expect(resolveFalImageQuality({})).toBe("high");
	});

	test("accepts fal image model endpoint aliases", () => {
		expect(
			resolveFalImageModelName({
				FAL_IMAGE_MODEL: "openai/gpt-image-2/edit",
			}),
		).toBe("gpt-image-2");
		expect(
			resolveFalImageModelName({
				FAL_IMAGE_MODEL: "fal-ai/nano-banana-pro/edit",
			}),
		).toBe("nano-banana-pro");
	});

	test("resolves automatic STT provider order", () => {
		expect(
			resolveSttProviderOrder({
				GOOGLE_API_KEY: "google",
				FAL_API_KEY: "fal",
				LEMON_FOX_API_KEY: "lemonfox",
			}),
		).toEqual(["gemini", "fal", "lemonfox"]);
	});

	test("prefers OpenAI STT when only OpenAI is configured", () => {
		expect(resolveSttProviderOrder({ OPENAI_API_KEY: "sk-test" })).toEqual([
			"openai",
		]);
	});

	test("explicit STT provider replaces fallback order", () => {
		expect(
			resolveSttProviderOrder({
				STT_PROVIDER: "fal",
				GOOGLE_API_KEY: "google",
				FAL_API_KEY: "fal",
			}),
		).toEqual(["fal"]);
	});

	test("TTS auto-selects only providers with complete required env", () => {
		expect(
			resolveTtsProviderName({
				INWORLD_API_KEY: "inworld",
				LEMON_FOX_API_KEY: "lemonfox",
			}),
		).toBe("lemonfox");
	});

	test("TTS falls back to OpenAI when only OPENAI_API_KEY is set", () => {
		expect(resolveTtsProviderName({ OPENAI_API_KEY: "sk-test" })).toBe(
			"openai",
		);
	});

	test("validation reports missing explicit provider keys", () => {
		const result = validateProviderConfiguration({
			GOOGLE_API_KEY: "google",
			TTS_PROVIDER: "fal",
		});
		expect(result.errors).toContain(
			"fal.ai TTS requires FAL_API_KEY when TTS_PROVIDER=fal.",
		);
	});

	test("OpenAI-only configuration is valid", () => {
		const result = validateProviderConfiguration({
			OPENAI_API_KEY: "sk-test",
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings.some((w) => w.includes("YouTube"))).toBe(true);
	});

	test("rejects a setup with neither OpenAI nor Google keys", () => {
		const result = validateProviderConfiguration({});
		expect(
			result.errors.some((error) => error.includes("OPENAI_API_KEY")),
		).toBe(true);
	});

	test("IMAGE_PROVIDER=openai requires OPENAI_API_KEY", () => {
		const result = validateProviderConfiguration({
			GOOGLE_API_KEY: "google",
			IMAGE_PROVIDER: "openai",
		});
		expect(result.errors).toContain(
			"OpenAI images require OPENAI_API_KEY when IMAGE_PROVIDER=openai.",
		);
	});

	test("explicit support axes require the matching key", () => {
		const result = validateProviderConfiguration({
			OPENAI_API_KEY: "sk-test",
			EMBEDDING_PROVIDER: "gemini",
			BACKGROUND_PROVIDER: "gemini",
		});
		expect(result.errors).toContain(
			"Embeddings require GOOGLE_API_KEY when EMBEDDING_PROVIDER=gemini.",
		);
		expect(result.errors).toContain(
			"Background work require GOOGLE_API_KEY when BACKGROUND_PROVIDER=gemini.",
		);
	});

	test("accepts openai as STT, TTS, and image provider names", () => {
		expect(isSttProviderName("openai")).toBe(true);
		expect(isTtsProviderName("openai")).toBe(true);
		expect(isImageProviderName("openai")).toBe(true);
		expect(resolveImageProviderName({ IMAGE_PROVIDER: "openai" })).toBe(
			"openai",
		);
	});

	test("accepts Cartesia as an explicit TTS provider", () => {
		expect(isTtsProviderName("cartesia")).toBe(true);
		expect(
			resolveTtsProviderName({
				TTS_PROVIDER: "cartesia",
				CARTESIA_API_KEY: "sk-car-test",
				CARTESIA_VOICE_ID: "voice-test",
			}),
		).toBe("cartesia");
	});

	test("Cartesia validation requires its API key and voice ID", () => {
		const result = validateProviderConfiguration({
			GOOGLE_API_KEY: "google",
			TTS_PROVIDER: "cartesia",
		});
		expect(result.errors).toContain(
			"Cartesia TTS requires CARTESIA_API_KEY, CARTESIA_VOICE_ID when TTS_PROVIDER=cartesia.",
		);
	});

	test("STT order prefers the AI platform key first", () => {
		expect(
			resolveSttProviderOrder({
				GOOGLE_API_KEY: "google",
				OPENAI_API_KEY: "sk-test",
			}),
		).toEqual(["gemini", "openai"]);
		expect(
			resolveSttProviderOrder({
				AI_PLATFORM: "openai",
				GOOGLE_API_KEY: "google",
				OPENAI_API_KEY: "sk-test",
			}),
		).toEqual(["openai", "gemini"]);
	});

	test("startup summary reports platform, embeddings, and background", () => {
		const lines = formatProviderStartupSummary({
			OPENAI_API_KEY: "sk-test",
		});
		expect(lines).toContain("[startup] AI platform: openai");
		expect(lines).toContain("[startup] Chat provider: openai");
		expect(lines).toContain("[startup] Embeddings: openai");
		expect(lines).toContain("[startup] Background: openai");
		expect(lines).toContain("[startup] Image provider: openai");
		expect(lines).toContain("[startup] STT provider order: openai");
		expect(lines).toContain("[startup] TTS provider: openai");
	});

	test("validation requires the DeepSeek key when selected", () => {
		const result = validateProviderConfiguration({
			CHAT_PROVIDER: "deepseek",
		});
		expect(result.errors).toContain(
			"DeepSeek chat requires DEEPSEEK_API_KEY when CHAT_PROVIDER=deepseek.",
		);
	});

	test("validation rejects invalid fal image model when fal images are selected", () => {
		const result = validateProviderConfiguration({
			IMAGE_PROVIDER: "fal",
			FAL_API_KEY: "fal",
			FAL_IMAGE_MODEL: "typo",
		});
		expect(result.errors).toContain(
			"fal.ai images require FAL_IMAGE_MODEL to be gpt-image-2 or nano-banana-pro when set.",
		);
	});

	test("validation rejects invalid fal image quality when GPT Image 2 is selected", () => {
		const result = validateProviderConfiguration({
			IMAGE_PROVIDER: "fal",
			FAL_API_KEY: "fal",
			FAL_IMAGE_MODEL: "gpt-image-2",
			FAL_IMAGE_QUALITY: "ultra",
		});
		expect(result.errors).toContain(
			"fal.ai images require FAL_IMAGE_QUALITY to be low, medium, or high when set.",
		);
	});

	test("provider configuration failure explains the selected provider and fix", () => {
		const result = validateProviderConfiguration({
			CHAT_PROVIDER: "deepseek",
		});
		const message = formatProviderConfigurationFailure(result, {
			CHAT_PROVIDER: "deepseek",
		});
		expect(message).toContain("Configured CHAT_PROVIDER: deepseek");
		expect(message).toContain("DEEPSEEK_API_KEY");
		expect(message).toContain("sudo journalctl -u hellybot");
	});

	test("/provider status says chat switching is independent", () => {
		const status = formatProviderCommandStatus(
			{ provider: "gemini", model: "gemini-3.6-flash" },
			{ GOOGLE_API_KEY: "google" },
		);
		expect(status).toContain("/provider solo cambia el chat");
		expect(status).toContain("STT: gemini");
		expect(status).toContain("TTS: none");
	});

	test("/provider status includes the fal image model when fal images are selected", () => {
		const status = formatProviderCommandStatus(
			{ provider: "gemini", model: "gemini-3.6-flash" },
			{
				GOOGLE_API_KEY: "google",
				IMAGE_PROVIDER: "fal",
				FAL_API_KEY: "fal",
				FAL_IMAGE_MODEL: "nano-banana-pro",
			},
		);
		expect(status).toContain("Imágenes: fal (nano-banana-pro)");
	});
});

describe("findEnvCaseMismatches", () => {
	test("flags a known var written with wrong case", () => {
		const warnings = findEnvCaseMismatches(["FAL_model"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"FAL_model"');
		expect(warnings[0]).toContain('"FAL_MODEL"');
	});

	test("flags lowercase core credentials", () => {
		const warnings = findEnvCaseMismatches(["bot_token", "google_api_key"]);
		expect(warnings).toHaveLength(2);
	});

	test("flags new OpenAI/image env vars written with wrong case", () => {
		const warnings = findEnvCaseMismatches([
			"openai_image_model",
			"ai_platform",
			"embedding_provider",
		]);
		expect(warnings).toHaveLength(3);
		expect(warnings.join("\n")).toContain("OPENAI_IMAGE_MODEL");
		expect(warnings.join("\n")).toContain("AI_PLATFORM");
		expect(warnings.join("\n")).toContain("EMBEDDING_PROVIDER");
	});

	test("does not flag correctly cased keys", () => {
		expect(
			findEnvCaseMismatches(["FAL_MODEL", "BOT_TOKEN", "CHAT_PROVIDER"]),
		).toHaveLength(0);
	});

	test("ignores unknown keys entirely", () => {
		expect(
			findEnvCaseMismatches(["MY_CUSTOM_VAR", "some_random"]),
		).toHaveLength(0);
	});
});
