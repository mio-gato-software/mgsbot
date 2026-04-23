import { describe, expect, test } from "bun:test";
import { cosineSimilarity } from "../src/embeddings.ts";
import {
	computeTextScore,
	hasSignificantContent,
	normalizeName,
} from "../src/memory/queries.ts";
import type { ConversationMessage } from "../src/types.ts";

describe("cosineSimilarity", () => {
	test("identical vectors return 1", () => {
		const v = [1, 2, 3];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
	});

	test("opposite vectors return -1", () => {
		const a = [1, 0, 0];
		const b = [-1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
	});

	test("orthogonal vectors return 0", () => {
		const a = [1, 0, 0];
		const b = [0, 1, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0);
	});

	test("different length vectors return 0", () => {
		expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
	});

	test("zero vectors return 0", () => {
		expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
		expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
	});

	test("empty vectors return 0", () => {
		expect(cosineSimilarity([], [])).toBe(0);
	});

	test("similar vectors have high similarity", () => {
		const a = [1, 2, 3, 4];
		const b = [1, 2, 3, 5];
		expect(cosineSimilarity(a, b)).toBeGreaterThan(0.95);
	});
});

describe("computeTextScore", () => {
	test("identical text returns 1", () => {
		expect(computeTextScore("hello world", "hello world")).toBe(1);
	});

	test("no overlap returns 0", () => {
		expect(computeTextScore("hello world", "foo bar")).toBe(0);
	});

	test("partial overlap returns fraction", () => {
		const score = computeTextScore("hello world foo", "hello bar baz");
		expect(score).toBeCloseTo(1 / 3);
	});

	test("empty query returns 0", () => {
		expect(computeTextScore("", "hello world")).toBe(0);
	});

	test("single char tokens are filtered out", () => {
		// "a" is length 1, filtered by tokenize. "hello" is the only real token
		expect(computeTextScore("a hello", "hello world")).toBe(1);
	});

	test("accent-insensitive matching", () => {
		// "café" normalizes to "cafe" (1 token), which matches "cafe bueno"
		expect(computeTextScore("café", "cafe bueno")).toBe(1);
		// "café hola" → 2 tokens, only 1 matches "cafe bueno"
		expect(computeTextScore("café hola", "cafe bueno")).toBe(0.5);
	});
});

describe("normalizeName", () => {
	test("lowercases and strips accents", () => {
		expect(normalizeName("François")).toBe("francois");
	});

	test("handles compound names", () => {
		expect(normalizeName("José María")).toBe("jose maria");
	});

	test("already normalized stays the same", () => {
		expect(normalizeName("john")).toBe("john");
	});
});

describe("hasSignificantContent", () => {
	function msg(content: string): ConversationMessage {
		return { role: "user", content, timestamp: Date.now() };
	}

	test("short greetings are not significant", () => {
		expect(hasSignificantContent([msg("hola"), msg("que tal")])).toBe(false);
	});

	test("long messages are significant", () => {
		const longText = "a".repeat(121);
		expect(hasSignificantContent([msg(longText)])).toBe(true);
	});

	test("messages with personal declarations are significant", () => {
		expect(hasSignificantContent([msg("Yo soy ingeniero")])).toBe(true);
	});

	test("messages with dates are significant", () => {
		expect(
			hasSignificantContent([msg("Mi cumpleaños es el 15 de marzo")]),
		).toBe(true);
	});

	test("messages with memory references are significant", () => {
		expect(hasSignificantContent([msg("¿Recuerdas lo que te dije?")])).toBe(
			true,
		);
	});

	test("messages with family names are significant", () => {
		expect(hasSignificantContent([msg("mi hijo se llama Carlos")])).toBe(true);
	});

	test("empty array is not significant", () => {
		expect(hasSignificantContent([])).toBe(false);
	});
});
