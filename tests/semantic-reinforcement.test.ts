import { describe, expect, test } from "bun:test";
import { applyRetrievalReinforcement } from "../src/memory/semantic.ts";
import type { SemanticFact } from "../src/types.ts";

const DAY_MS = 86_400_000;

function makeFact(
	overrides: Partial<SemanticFact> & { id: string },
): SemanticFact {
	const tenDaysAgo = Date.now() - 10 * DAY_MS;
	return {
		content: "test fact",
		category: "person",
		subject: "Tester",
		embedding: [],
		importance: 3,
		confidence: 0.5,
		createdAt: tenDaysAgo,
		lastConfirmed: tenDaysAgo,
		lastDecayedAt: tenDaysAgo,
		...overrides,
	};
}

describe("applyRetrievalReinforcement", () => {
	test("recalled fact gets decay clock reset and a confidence bump", () => {
		const now = Date.now();
		const fact = makeFact({ id: "f1" });
		const changed = applyRetrievalReinforcement([fact], ["f1"], now);

		expect(changed).toBe(1);
		expect(fact.lastConfirmed).toBe(now);
		expect(fact.lastDecayedAt).toBe(now);
		expect(fact.confidence).toBeCloseTo(0.55);
	});

	test("confidence is capped at 1", () => {
		const fact = makeFact({ id: "f1", confidence: 0.98 });
		applyRetrievalReinforcement([fact], ["f1"]);
		expect(fact.confidence).toBe(1);
	});

	test("facts not in the recalled set are untouched", () => {
		const fact = makeFact({ id: "f1" });
		const before = fact.lastConfirmed;
		expect(applyRetrievalReinforcement([fact], ["other"])).toBe(0);
		expect(fact.lastConfirmed).toBe(before);
	});

	test("recently confirmed facts are throttled", () => {
		const now = Date.now();
		const fact = makeFact({
			id: "f1",
			lastConfirmed: now - 10 * 60 * 1000, // 10 minutes ago
			confidence: 0.5,
		});
		expect(applyRetrievalReinforcement([fact], ["f1"], now)).toBe(0);
		expect(fact.confidence).toBe(0.5);
	});

	test("permanent and retired facts are never reinforced", () => {
		const now = Date.now();
		const permanent = makeFact({ id: "p1", permanent: true });
		const superseded = makeFact({ id: "s1", supersededBy: "f9" });
		const expired = makeFact({ id: "e1", validUntil: now - 1000 });

		expect(
			applyRetrievalReinforcement(
				[permanent, superseded, expired],
				["p1", "s1", "e1"],
				now,
			),
		).toBe(0);
	});
});
