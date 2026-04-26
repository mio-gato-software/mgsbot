import { describe, expect, test } from "bun:test";
import { parseBotRules } from "../src/bot-rules.ts";
import { parseManualProfile } from "../src/config.ts";

describe("manual bot profile", () => {
	test("accepts a complete headless profile", () => {
		const profile = parseManualProfile({
			botName: "Mía",
			birthYear: 1995,
			gender: "mujer",
			personality: "Cálida, curiosa y directa.",
			language: "es",
		});

		expect(profile).toEqual({
			isConfigured: true,
			botName: "Mía",
			birthYear: 1995,
			gender: "mujer",
			personality: "Cálida, curiosa y directa.",
			language: "es",
		});
	});

	test("rejects incomplete profiles", () => {
		expect(
			parseManualProfile({
				botName: "Mía",
				birthYear: 1995,
				gender: "mujer",
			}),
		).toBeNull();
	});

	test("defaults invalid language to Spanish", () => {
		const profile = parseManualProfile({
			botName: "Mía",
			birthYear: 1995,
			gender: "mujer",
			personality: "Cálida.",
			language: "fr",
		});

		expect(profile?.language).toBe("es");
	});
});

describe("manual bot rules", () => {
	test("keeps supported rule lists", () => {
		const rules = parseBotRules({
			customInstructions: ["Be direct", "", "  Stay warm  "],
			styleRules: ["No corporate tone"],
			relationshipRules: ["Use memories subtly"],
			groupRules: ["Stay brief in groups"],
			newPersonRules: ["Welcome people gently"],
			unknownRules: ["ignored"],
		});

		expect(rules).toEqual({
			customInstructions: ["Be direct", "Stay warm"],
			styleRules: ["No corporate tone"],
			relationshipRules: ["Use memories subtly"],
			groupRules: ["Stay brief in groups"],
			newPersonRules: ["Welcome people gently"],
		});
	});

	test("ignores malformed rule values", () => {
		expect(
			parseBotRules({
				customInstructions: "Be direct",
				styleRules: [1, null, "Valid"],
			}),
		).toEqual({
			styleRules: ["Valid"],
		});
	});
});
