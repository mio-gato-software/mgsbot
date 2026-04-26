import { describe, expect, test } from "bun:test";
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
