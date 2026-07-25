/**
 * Promotion decision report — `bun run promote:stats`.
 *
 * Answers the two questions that can only be settled with real traffic:
 *
 *  - Is the passive-overflow bar calibrated? The counterfactual table replays
 *    every recorded decision through the real gate (`meetsPromotionBar`) at each
 *    candidate bar, and the tail lists the chunks the current bar dropped so you
 *    can judge whether they were noise or context you'd have wanted later.
 *  - Is extraction still good on the cheap background model? Per-model parse
 *    failures, facts per chunk, validator-dropped facts, and empty extractions.
 *
 * Usage:
 *   bun run promote:stats            # full report, last 15 dropped chunks
 *   bun run promote:stats --dropped 50
 *   bun run promote:stats --json
 */

import {
	loadPromotionMetrics,
	type PromotionMetricRecord,
	summarizePromotionMetrics,
} from "../src/memory/promotion-metrics.ts";
import {
	defaultPromotionBar,
	passivePromotionBar,
} from "../src/memory/promotion-policy.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const droppedIndex = args.indexOf("--dropped");
const droppedLimit =
	droppedIndex >= 0 ? Number(args[droppedIndex + 1] ?? 15) : 15;

function pct(part: number, total: number): string {
	if (!total) return "—";
	return `${((part / total) * 100).toFixed(0)}%`;
}

function stamp(ts?: number): string {
	if (!ts) return "—";
	return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function bar(count: number, max: number): string {
	if (!max) return "";
	return "#".repeat(Math.max(0, Math.round((count / max) * 30)));
}

const records = await loadPromotionMetrics();

if (records.length === 0) {
	console.log(
		"No promotion decisions recorded yet.\n" +
			"They accumulate in memory/metrics/ as the bot promotes chunks " +
			"(disable with PROMOTION_METRICS=false).",
	);
	process.exit(0);
}

const summary = summarizePromotionMetrics(records);

if (asJson) {
	console.log(JSON.stringify(summary, null, 2));
	process.exit(0);
}

const activeBar = defaultPromotionBar();
const passiveBar = passivePromotionBar();

console.log(
	`\nPromotion decisions — ${summary.total} records (${stamp(summary.from)} → ${stamp(summary.to)}), ${summary.retries} from the retry spool`,
);
console.log(`Bars in effect: active=${activeBar} passive=${passiveBar}\n`);

for (const [source, stats] of Object.entries(summary.bySource)) {
	if (stats.total === 0) continue;
	const currentBar = source === "passive" ? passiveBar : activeBar;
	console.log(
		`${source.toUpperCase()} — ${stats.total} chunks, kept ${stats.kept} (${pct(stats.kept, stats.total)}) at bar ${currentBar}`,
	);

	const max = Math.max(...stats.importanceHistogram);
	stats.importanceHistogram.forEach((count, importance) => {
		if (count === 0) return;
		const label = importance === 0 ? "failed" : `imp ${importance}`;
		console.log(
			`  ${label.padEnd(7)} ${String(count).padStart(5)}  ${bar(count, max)}`,
		);
	});

	console.log("  bar  would keep   newly dropped   newly kept");
	for (const row of stats.counterfactual) {
		console.log(
			`  ${String(row.bar).padEnd(4)} ${String(row.kept).padStart(10)} ${String(row.newlyDropped).padStart(15)} ${String(row.newlyKept).padStart(12)}`,
		);
	}
	console.log("");
}

console.log("Extraction quality");
console.log(
	"  model                              chunks  parse-fail  facts/chunk  facts dropped  empty",
);
const rows: Array<[string, typeof summary.extraction]> = [
	...Object.entries(summary.byModel),
	["ALL", summary.extraction],
];
for (const [model, stats] of rows) {
	console.log(
		`  ${model.slice(0, 34).padEnd(34)} ${String(stats.chunks).padStart(6)} ${`${stats.parseFailures} (${pct(stats.parseFailures, stats.chunks)})`.padStart(11)} ${stats.factsPerChunk.toFixed(2).padStart(12)} ${pct(stats.droppedFactRate, 1).padStart(14)} ${pct(stats.emptyExtractions, stats.chunks).padStart(6)}`,
	);
}

const dropped: PromotionMetricRecord[] = records
	.filter((record) => record.parseOk && !record.kept)
	.slice(-droppedLimit);

if (dropped.length > 0) {
	console.log(
		`\nLast ${dropped.length} chunks the bar dropped — would you have wanted these later?`,
	);
	for (const record of dropped) {
		console.log(
			`  [${stamp(record.ts)}] ${record.source} bar=${record.bar} imp=${record.importance} facts=[${record.factImportances.join(",")}] — ${record.summary}`,
		);
	}
}
console.log("");
