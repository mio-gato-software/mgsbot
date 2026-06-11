import { describe, expect, test } from "bun:test";
import {
	applySignalsToState,
	createEmptyState,
	getTraitTier,
	migrateState,
} from "../src/personality.ts";
import { TRAIT_NAMES } from "../src/types.ts";

describe("getTraitTier", () => {
	test("boundaries at 0.33 and 0.67", () => {
		expect(getTraitTier(0)).toBe("low");
		expect(getTraitTier(0.33)).toBe("low");
		expect(getTraitTier(0.331)).toBe("mid");
		expect(getTraitTier(0.5)).toBe("mid");
		expect(getTraitTier(0.669)).toBe("mid");
		expect(getTraitTier(0.67)).toBe("high");
		expect(getTraitTier(1)).toBe("high");
	});
});

describe("createEmptyState", () => {
	test("creates all fixed traits at neutral", () => {
		const state = createEmptyState();
		expect(Object.keys(state.traits).sort()).toEqual([...TRAIT_NAMES].sort());
		for (const trait of Object.values(state.traits)) {
			expect(trait.value).toBe(0.5);
			expect(trait.momentum).toBe(0);
		}
		expect(state.recentGrowth).toEqual([]);
	});
});

describe("applySignalsToState", () => {
	const signals = (trait: string, delta: number) => ({
		traitChanges: [{ trait, delta, reason: "test" }],
	});

	test("applies delta and updates momentum", () => {
		const state = createEmptyState();
		const affected = applySignalsToState(
			state,
			signals("warmth", 0.1),
			"ctx",
			1000,
		);
		expect(affected).toEqual(["warmth"]);
		expect(state.traits.warmth?.value).toBeCloseTo(0.6);
		// momentum = 0 * 0.7 + 0.1
		expect(state.traits.warmth?.momentum).toBeCloseTo(0.1);
		expect(state.traits.warmth?.lastReinforced).toBe(1000);
	});

	test("momentum smooths across successive updates", () => {
		const state = createEmptyState();
		applySignalsToState(state, signals("humor", 0.1), "ctx");
		applySignalsToState(state, signals("humor", 0.1), "ctx");
		// momentum = (0 * 0.7 + 0.1) * 0.7 + 0.1 = 0.17
		expect(state.traits.humor?.momentum).toBeCloseTo(0.17);
		expect(state.traits.humor?.value).toBeCloseTo(0.7);
	});

	test("clamps delta to ±0.15", () => {
		const state = createEmptyState();
		applySignalsToState(state, signals("energy", 0.9), "ctx");
		expect(state.traits.energy?.value).toBeCloseTo(0.65);
	});

	test("clamps trait value to [0, 1]", () => {
		const state = createEmptyState();
		for (let i = 0; i < 10; i++) {
			applySignalsToState(state, signals("patience", -0.15), "ctx");
		}
		expect(state.traits.patience?.value).toBe(0);
	});

	test("ignores deltas below 0.01", () => {
		const state = createEmptyState();
		const affected = applySignalsToState(
			state,
			signals("warmth", 0.005),
			"ctx",
		);
		expect(affected).toEqual([]);
		expect(state.traits.warmth?.value).toBe(0.5);
		expect(state.recentGrowth).toHaveLength(0);
	});

	test("rejects unknown traits", () => {
		const state = createEmptyState();
		const affected = applySignalsToState(
			state,
			signals("charisma", 0.1),
			"ctx",
		);
		expect(affected).toEqual([]);
		expect(state.recentGrowth).toHaveLength(0);
	});

	test("records growth events and caps them at 10", () => {
		const state = createEmptyState();
		for (let i = 0; i < 12; i++) {
			applySignalsToState(state, signals("warmth", 0.05), `ctx ${i}`);
		}
		expect(state.recentGrowth).toHaveLength(10);
		expect(state.recentGrowth[9]?.trigger).toBe("ctx 11");
		expect(state.recentGrowth[0]?.trigger).toBe("ctx 2");
	});

	test("truncates growth trigger to 200 chars", () => {
		const state = createEmptyState();
		applySignalsToState(state, signals("warmth", 0.1), "x".repeat(500));
		expect(state.recentGrowth[0]?.trigger).toHaveLength(200);
	});
});

describe("migrateState", () => {
	test("maps legacy Spanish trait names to fixed traits", () => {
		const state = migrateState({
			traits: {
				calidez: { value: 0.8, momentum: 0.2, lastReinforced: 1 },
				paciencia: { value: 0.3, momentum: 0, lastReinforced: 1 },
			},
		});
		expect(state.traits.warmth?.value).toBeCloseTo(0.8);
		expect(state.traits.patience?.value).toBeCloseTo(0.3);
		// Migrated traits reset momentum
		expect(state.traits.warmth?.momentum).toBe(0);
	});

	test("averages multiple legacy traits mapping to the same target", () => {
		const state = migrateState({
			traits: {
				warmth: { value: 0.9, momentum: 0, lastReinforced: 1 },
				cariño: { value: 0.5, momentum: 0, lastReinforced: 1 },
			},
		});
		expect(state.traits.warmth?.value).toBeCloseTo(0.7);
	});

	test("unknown legacy traits are dropped, target stays neutral", () => {
		const state = migrateState({
			traits: {
				estoicismo_zen: { value: 0.9, momentum: 0, lastReinforced: 1 },
			},
		});
		for (const name of TRAIT_NAMES) {
			expect(state.traits[name]?.value).toBe(0.5);
		}
	});

	test("preserves last 10 growth events", () => {
		const growth = Array.from({ length: 15 }, (_, i) => ({
			change: `c${i}`,
			trigger: "t",
			timestamp: i,
			traitsAffected: [],
		}));
		const state = migrateState({ traits: {}, recentGrowth: growth });
		expect(state.recentGrowth).toHaveLength(10);
		expect(state.recentGrowth[0]?.change).toBe("c5");
	});

	test("handles malformed legacy traits without crashing", () => {
		const state = migrateState({
			traits: {
				humor: { value: "high" },
				warmth: null,
			},
		});
		expect(state.traits.humor?.value).toBe(0.5);
		expect(state.traits.warmth?.value).toBe(0.5);
	});
});
