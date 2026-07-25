import { afterEach, describe, expect, test } from "bun:test";
import {
	type PromotionMetricRecord,
	summarizePromotionMetrics,
} from "../src/memory/promotion-metrics.ts";
import {
	defaultPromotionBar,
	meetsPromotionBar,
	passivePromotionBar,
} from "../src/memory/promotion-policy.ts";

function signal(
	importance: number,
	factImportances: number[] = [],
	hasPersonalitySignals = false,
) {
	return { importance, factImportances, hasPersonalitySignals };
}

describe("promotion bars", () => {
	afterEach(() => {
		delete process.env.PROMOTION_MIN_IMPORTANCE;
		delete process.env.PASSIVE_PROMOTION_MIN_IMPORTANCE;
	});

	test("default to 2 (active) and 3 (passive)", () => {
		expect(defaultPromotionBar()).toBe(2);
		expect(passivePromotionBar()).toBe(3);
	});

	test("are env-tunable and clamped to 1-5", () => {
		process.env.PROMOTION_MIN_IMPORTANCE = "1";
		process.env.PASSIVE_PROMOTION_MIN_IMPORTANCE = "9";
		expect(defaultPromotionBar()).toBe(1);
		expect(passivePromotionBar()).toBe(5);
	});

	test("ignore unparseable values", () => {
		process.env.PASSIVE_PROMOTION_MIN_IMPORTANCE = "high";
		expect(passivePromotionBar()).toBe(3);
	});
});

describe("meetsPromotionBar", () => {
	test("at the default bar, any fact or personality signal rescues a chunk", () => {
		expect(meetsPromotionBar(signal(1, [1]), 2, 2)).toBe(true);
		expect(meetsPromotionBar(signal(1, [], true), 2, 2)).toBe(true);
		expect(meetsPromotionBar(signal(1), 2, 2)).toBe(false);
	});

	test("above the default bar, the episode or a fact must clear the bar itself", () => {
		expect(meetsPromotionBar(signal(1, [2]), 3, 2)).toBe(false);
		expect(meetsPromotionBar(signal(1, [3]), 3, 2)).toBe(true);
		expect(meetsPromotionBar(signal(3, []), 3, 2)).toBe(true);
		// Personality movement alone no longer rescues passive chatter.
		expect(meetsPromotionBar(signal(1, [], true), 3, 2)).toBe(false);
	});
});

function record(
	overrides: Partial<PromotionMetricRecord>,
): PromotionMetricRecord {
	return {
		ts: 1_700_000_000_000,
		chatId: 1,
		source: "passive",
		retried: false,
		bar: 3,
		defaultBar: 2,
		messageCount: 5,
		model: "gemini-3.6-flash",
		parseOk: true,
		importance: 2,
		factImportances: [],
		droppedFacts: 0,
		hasPersonalitySignals: false,
		kept: false,
		summary: "chatter",
		...overrides,
	};
}

describe("summarizePromotionMetrics", () => {
	test("replays every bar so the passive bar can be calibrated", () => {
		const records = [
			// Kept at bar 3 (episode importance clears it).
			record({ importance: 3, kept: true }),
			// Dropped at bar 3, but a bar of 2 would have kept it.
			record({ importance: 2, kept: false }),
			// Dropped at any bar above 1.
			record({ importance: 1, kept: false }),
		];

		const { bySource } = summarizePromotionMetrics(records);
		const passive = bySource.passive;
		const at = (bar: number) =>
			passive.counterfactual.find((row) => row.bar === bar);

		expect(passive.total).toBe(3);
		expect(passive.kept).toBe(1);
		expect(at(1)?.kept).toBe(3);
		expect(at(2)?.kept).toBe(2);
		expect(at(3)?.kept).toBe(1);
		expect(at(4)?.kept).toBe(0);
		// Lowering to 2 rescues the importance-2 chunk without dropping anything.
		expect(at(2)?.newlyKept).toBe(1);
		expect(at(2)?.newlyDropped).toBe(0);
		// Raising to 4 would drop a chunk the current bar keeps.
		expect(at(4)?.newlyDropped).toBe(1);
		expect(passive.importanceHistogram[3]).toBe(1);
	});

	test("tracks extraction quality per model", () => {
		const records = [
			record({ model: "cheap", factImportances: [3, 4], droppedFacts: 2 }),
			record({ model: "cheap", parseOk: false, importance: 0 }),
			record({ model: "frontier", factImportances: [5] }),
		];

		const summary = summarizePromotionMetrics(records);
		expect(summary.byModel.cheap?.chunks).toBe(2);
		expect(summary.byModel.cheap?.parseFailures).toBe(1);
		expect(summary.byModel.cheap?.factsPerChunk).toBe(1);
		expect(summary.byModel.cheap?.droppedFactRate).toBeCloseTo(0.5);
		expect(summary.byModel.frontier?.parseFailures).toBe(0);
		expect(summary.byModel.frontier?.emptyExtractions).toBe(0);
		expect(summary.extraction.chunks).toBe(3);
	});

	test("counts retries and ignores failed extractions in the bar replay", () => {
		const records = [
			record({ retried: true, parseOk: false, importance: 0 }),
			record({ importance: 5, kept: true }),
		];
		const summary = summarizePromotionMetrics(records);
		expect(summary.retries).toBe(1);
		expect(
			summary.bySource.passive.counterfactual.find((row) => row.bar === 1)
				?.kept,
		).toBe(1);
	});
});
