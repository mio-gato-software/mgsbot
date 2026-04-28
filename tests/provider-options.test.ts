import { describe, expect, test } from "bun:test";
import {
	formatProviderCommandStatus,
	formatProviderConfigurationFailure,
	resolveChatProviderName,
	resolveFalImageModelName,
	resolveSttProviderOrder,
	resolveTtsProviderName,
	validateProviderConfiguration,
} from "../src/provider-options.ts";

describe("provider options", () => {
	test("defaults chat provider to gemini", () => {
		expect(resolveChatProviderName({})).toBe("gemini");
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

	test("defaults fal image model to GPT Image 2", () => {
		expect(resolveFalImageModelName({})).toBe("gpt-image-2");
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

	test("validation reports missing explicit provider keys", () => {
		const result = validateProviderConfiguration({
			GOOGLE_API_KEY: "google",
			TTS_PROVIDER: "fal",
		});
		expect(result.errors).toContain(
			"fal.ai TTS requires FAL_API_KEY when TTS_PROVIDER=fal.",
		);
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
			{ provider: "gemini", model: "gemini-3-flash-preview" },
			{ GOOGLE_API_KEY: "google" },
		);
		expect(status).toContain("/provider solo cambia el chat");
		expect(status).toContain("STT: gemini");
		expect(status).toContain("TTS: none");
	});

	test("/provider status includes the fal image model when fal images are selected", () => {
		const status = formatProviderCommandStatus(
			{ provider: "gemini", model: "gemini-3-flash-preview" },
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
