/**
 * Promotion importance bars — the gate that decides whether an overflowed
 * conversation chunk becomes long-term memory.
 *
 * The bars are env-tunable on purpose: they were picked a priori, and the only
 * honest way to set them is against real traffic (see promotion-metrics.ts and
 * `bun run promote:stats`, which replay recorded decisions through
 * `meetsPromotionBar` at every candidate bar). Raising a bar silently drops
 * context whose value only becomes obvious later, so tune it from the data.
 */

const DEFAULT_MIN_IMPORTANCE = 2;
const PASSIVE_MIN_IMPORTANCE = 3;

function envBar(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	if (!Number.isFinite(raw)) return fallback;
	return Math.max(1, Math.min(5, Math.round(raw)));
}

/** Bar for chunks from conversations the bot took part in. */
export function defaultPromotionBar(): number {
	return envBar("PROMOTION_MIN_IMPORTANCE", DEFAULT_MIN_IMPORTANCE);
}

/** Bar for passively witnessed group chatter (the bot wasn't addressed). */
export function passivePromotionBar(): number {
	return envBar("PASSIVE_PROMOTION_MIN_IMPORTANCE", PASSIVE_MIN_IMPORTANCE);
}

/** Everything the bar decision looks at, extracted from a promotion result. */
export interface PromotionSignal {
	/** LLM-judged episode importance, 1-5. */
	importance: number;
	/** Importance of each extracted fact, 1-5. */
	factImportances: number[];
	/** Whether the chunk produced personality trait movement. */
	hasPersonalitySignals: boolean;
}

/**
 * Decide whether a chunk clears `bar`. At the default bar any fact or
 * personality signal rescues the chunk; above it (passive group chatter) the
 * episode or a fact must itself clear the bar.
 *
 * Pure and dependency-free so the stats script can replay recorded decisions
 * through the exact logic the bot runs.
 */
export function meetsPromotionBar(
	signal: PromotionSignal,
	bar: number,
	defaultBar: number = defaultPromotionBar(),
): boolean {
	const aboveDefaultBar = bar > defaultBar;
	const hasQualifyingFacts = aboveDefaultBar
		? signal.factImportances.some((importance) => importance >= bar)
		: signal.factImportances.length > 0;
	return (
		signal.importance >= bar ||
		hasQualifyingFacts ||
		(!aboveDefaultBar && signal.hasPersonalitySignals)
	);
}
