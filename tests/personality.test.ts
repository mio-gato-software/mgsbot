import { describe, expect, test } from "bun:test";
import {
	applySignalsToState,
	createEmptyState,
	effectiveTraitValue,
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
		expect(state.traits.warmth?.value).toBeGreaterThan(0.5);
		expect(state.traits.warmth?.value).toBeLessThan(0.53);
		// A single signal contributes 30% to the moving average.
		expect(state.traits.warmth?.momentum).toBeCloseTo(0.03);
		expect(state.traits.warmth?.lastReinforced).toBe(1000);
	});

	test("momentum smooths across successive updates", () => {
		const state = createEmptyState();
		applySignalsToState(state, signals("humor", 0.1), "ctx");
		applySignalsToState(state, signals("humor", 0.1), "ctx");
		// Repeated evidence strengthens the moving average without a large jump.
		expect(state.traits.humor?.momentum).toBeCloseTo(0.051);
		expect(state.traits.humor?.value).toBeGreaterThan(0.51);
		expect(state.traits.humor?.value).toBeLessThan(0.54);
	});

	test("clamps delta to ±0.15", () => {
		const state = createEmptyState();
		applySignalsToState(state, signals("energy", 0.9), "ctx");
		expect(state.traits.energy?.value).toBeLessThan(0.52);
		expect(state.traits.energy?.value).toBeGreaterThan(0.5);
	});

	test("sustained feedback stays bounded without saturating", () => {
		const state = createEmptyState();
		for (let i = 0; i < 200; i++) {
			applySignalsToState(state, signals("patience", -0.15), "ctx");
		}
		expect(state.traits.patience?.value).toBeGreaterThanOrEqual(0.15);
		expect(state.traits.patience?.value).toBeLessThan(0.2);
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

test("old saturation fades without modifying stored history, and new contrary feedback can reverse it", () => {
	const state = createEmptyState();
	state.traits.humor = { value: 1, momentum: 0.5, lastReinforced: 1000 };
	expect(
		effectiveTraitValue(state.traits.humor, 1000 + 30 * 86400000),
	).toBeCloseTo(0.75);
	expect(
		effectiveTraitValue(state.traits.humor, 1000 + 90 * 86400000),
	).toBeCloseTo(0.5625);
	expect(state.traits.humor.value).toBe(1);
	for (let i = 0; i < 40; i++)
		applySignalsToState(
			state,
			{
				traitChanges: [
					{
						trait: "humor",
						delta: -0.1,
						reason: "Please stop joking when I ask for help",
					},
				],
			},
			"feedback",
			1000 + i * 86400000,
		);
	expect(state.traits.humor.value).toBeLessThan(0.5);
});

test("duplicate traits and nonfinite signals cannot amplify a single extraction", () => {
	const state = createEmptyState();
	const changes = [
		{ trait: "humor", delta: 0.1, reason: "feedback" },
		{ trait: "humor", delta: 0.1, reason: "same feedback" },
		{ trait: "warmth", delta: NaN, reason: "invalid" },
	];
	expect(applySignalsToState(state, { traitChanges: changes }, "test")).toEqual(
		["humor"],
	);
	expect(state.traits.humor?.value).toBeLessThan(0.53);
	expect(state.traits.warmth?.value).toBe(0.5);
});

test("extraction rejects personality changes without direct user evidence", async () => {
	const { validatePromotionResult } = await import("../src/ai/evaluation.ts");
	const base = { summary: "chat", importance: 2, facts: [] };
	const result = validatePromotionResult({
		...base,
		personalitySignals: {
			traitChanges: [
				{
					trait: "warmth",
					delta: 0.1,
					reason: "Two friends were affectionate",
				},
				{
					trait: "humor",
					delta: -0.1,
					reason: "User asked the bot to stop joking",
					directToBot: true,
					evidence: "DemoBot, deja las bromas cuando te pregunto algo serio",
				},
			],
		},
	});
	expect(result.personalitySignals?.traitChanges.map((c) => c.trait)).toEqual([
		"humor",
	]);
});
