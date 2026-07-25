import { describe, expect, test } from "bun:test";
import {
	applyRetrievalReinforcement,
	REINFORCEMENT_CEILING_EROSION_PER_DAY,
	REINFORCEMENT_CONFIDENCE_CEILING,
	reinforcementCeiling,
} from "../src/memory/semantic.ts";
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
	test("recalled fact gets a confidence bump and a recall timestamp", () => {
		const now = Date.now();
		const fact = makeFact({ id: "f1" });
		const changed = applyRetrievalReinforcement([fact], ["f1"], now);

		expect(changed).toBe(1);
		expect(fact.lastRecalledAt).toBe(now);
		expect(fact.confidence).toBeCloseTo(0.55);
	});

	test("does not reset the decay or confirmation clocks", () => {
		const now = Date.now();
		const fact = makeFact({ id: "f1" });
		const confirmedBefore = fact.lastConfirmed;
		const decayedBefore = fact.lastDecayedAt;

		applyRetrievalReinforcement([fact], ["f1"], now);

		// Retrieval must not look like reconfirmation: daily decay keeps running.
		expect(fact.lastConfirmed).toBe(confirmedBefore);
		expect(fact.lastDecayedAt).toBe(decayedBefore);
	});

	test("repetition cannot push confidence past the eroding ceiling", () => {
		const now = Date.now();
		const fact = makeFact({ id: "f1", confidence: 0.9 });
		applyRetrievalReinforcement([fact], ["f1"], now);

		// Already above the ceiling (genuine reconfirmation put it there):
		// reinforcement leaves it alone rather than climbing toward 1.
		expect(fact.confidence).toBe(0.9);

		// Below the ceiling: the bump lands exactly on it and stops there.
		const climbing = makeFact({ id: "f2", confidence: 0.6 });
		applyRetrievalReinforcement([climbing], ["f2"], now);
		expect(climbing.confidence).toBeCloseTo(
			REINFORCEMENT_CONFIDENCE_CEILING -
				10 * REINFORCEMENT_CEILING_EROSION_PER_DAY,
		);
	});

	test("the ceiling erodes with the age of the last real confirmation", () => {
		const now = Date.now();
		const fresh = makeFact({ id: "f1", lastConfirmed: now });
		const stale = makeFact({ id: "f2", lastConfirmed: now - 40 * DAY_MS });

		expect(reinforcementCeiling(fresh, now)).toBeCloseTo(
			REINFORCEMENT_CONFIDENCE_CEILING,
		);
		expect(reinforcementCeiling(stale, now)).toBeCloseTo(
			REINFORCEMENT_CONFIDENCE_CEILING -
				40 * REINFORCEMENT_CEILING_EROSION_PER_DAY,
		);
		expect(reinforcementCeiling(stale, now)).toBeLessThan(
			reinforcementCeiling(fresh, now),
		);
	});

	test("a fact that is only ever recalled eventually decays out", () => {
		const now = Date.now();
		// Never reconfirmed in conversation for 80 days: the ceiling has eroded
		// below the store's minimum confidence, so repetition can no longer keep
		// the fact alive.
		const ancient = makeFact({
			id: "f1",
			lastConfirmed: now - 80 * DAY_MS,
			confidence: 0.05,
		});
		applyRetrievalReinforcement([ancient], ["f1"], now);
		expect(reinforcementCeiling(ancient, now)).toBeLessThan(0.1);
		expect(ancient.confidence).toBeLessThan(0.1);
	});

	test("facts not in the recalled set are untouched", () => {
		const fact = makeFact({ id: "f1" });
		expect(applyRetrievalReinforcement([fact], ["other"])).toBe(0);
		expect(fact.lastRecalledAt).toBeUndefined();
	});

	test("recently recalled facts are throttled", () => {
		const now = Date.now();
		const fact = makeFact({
			id: "f1",
			lastRecalledAt: now - 10 * 60 * 1000, // 10 minutes ago
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
