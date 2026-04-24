import { describe, expect, test } from "bun:test";
import {
	formatProviderCommandStatus,
	resolveChatProviderName,
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
			"Invalid CHAT_PROVIDER",
		);
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

	test("/provider status says chat switching is independent", () => {
		const status = formatProviderCommandStatus(
			{ provider: "gemini", model: "gemini-3-flash-preview" },
			{ GOOGLE_API_KEY: "google" },
		);
		expect(status).toContain("/provider solo cambia el chat");
		expect(status).toContain("STT: gemini");
		expect(status).toContain("TTS: none");
	});
});
