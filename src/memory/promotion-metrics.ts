/**
 * Promotion decision telemetry.
 *
 * Every extraction attempt appends one JSONL record to
 * `memory/metrics/promotion-YYYY-MM.jsonl`. Two questions can only be answered
 * from real traffic, and both are answered from this file:
 *
 *  1. Is the passive-overflow bar set right? A bar is a guess until you can see
 *     what it dropped, so the record keeps the episode summary and the fact
 *     importances of *skipped* chunks too — the ones a bar silently discards.
 *  2. Is extraction still good now that it runs on a cheap background model?
 *     Each record carries the model id, whether the JSON parsed, how many facts
 *     came back, and how many the validator had to throw away — so quality can
 *     be compared across models and over time instead of assumed.
 *
 * `bun run promote:stats` renders both. Records stay local (under `memory/`,
 * which is gitignored) and are pruned to the last few months.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { botNow } from "../bot-time.ts";
import { log } from "../logger.ts";
import { isFileNotFound } from "../utils.ts";
import { meetsPromotionBar } from "./promotion-policy.ts";

export const METRICS_DIR = "./memory/metrics";

const DEFAULT_RETENTION_MONTHS = 6;
const SUMMARY_MAX_CHARS = 300;

/**
 * Promotion path the chunk came from: a conversation the bot took part in
 * ("active") or group chatter it merely witnessed ("passive"). Retries keep the
 * original source — see the `retried` flag.
 */
export type PromotionSource = "active" | "passive";

export interface PromotionMetricRecord {
	ts: number;
	chatId: number;
	source: PromotionSource;
	/** True when this attempt came from the retry spool. */
	retried: boolean;
	/** Bar this chunk was judged against. */
	bar: number;
	/** Default bar in effect, needed to replay the "above default bar" rule. */
	defaultBar: number;
	messageCount: number;
	/** Model that produced the extraction (empty when the call failed). */
	model: string;
	/** False when the extractor's reply could not be parsed as JSON. */
	parseOk: boolean;
	/** LLM-judged episode importance, 1-5 (0 when extraction failed). */
	importance: number;
	factImportances: number[];
	/** Facts the validator rejected (bad category, missing subject, ...). */
	droppedFacts: number;
	hasPersonalitySignals: boolean;
	/** Whether the chunk was actually written to long-term memory. */
	kept: boolean;
	/** Episode summary — lets a dropped chunk be judged after the fact. */
	summary: string;
}

function enabled(): boolean {
	return process.env.PROMOTION_METRICS !== "false";
}

function retentionMonths(): number {
	const raw = Number(process.env.PROMOTION_METRICS_RETENTION_MONTHS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_MONTHS;
}

function monthKey(date?: Date | number): string {
	return botNow(date).format("YYYY-MM");
}

export function metricsFilePath(month = monthKey()): string {
	return `${METRICS_DIR}/promotion-${month}.jsonl`;
}

// Month of the last write; retention only runs when it changes.
let lastWrittenMonth: string | null = null;

async function pruneOldMetrics(): Promise<void> {
	try {
		const files = (await readdir(METRICS_DIR))
			.filter((file) => /^promotion-\d{4}-\d{2}\.jsonl$/.test(file))
			.sort();
		const excess = files.length - retentionMonths();
		for (const file of files.slice(0, Math.max(0, excess))) {
			await unlink(`${METRICS_DIR}/${file}`).catch(() => {});
		}
	} catch (error) {
		if (!isFileNotFound(error)) {
			log.debug("[promote-metrics] Pruning failed:", error);
		}
	}
}

/** Append one decision record. Never throws — telemetry must not break promotion. */
export async function recordPromotionDecision(
	record: PromotionMetricRecord,
): Promise<void> {
	if (!enabled()) return;
	try {
		if (!existsSync(METRICS_DIR)) {
			await mkdir(METRICS_DIR, { recursive: true });
		}
		const month = monthKey(record.ts);
		if (month !== lastWrittenMonth) {
			lastWrittenMonth = month;
			await pruneOldMetrics();
		}
		const line = JSON.stringify({
			...record,
			summary: record.summary.slice(0, SUMMARY_MAX_CHARS),
		});
		await appendFile(metricsFilePath(month), `${line}\n`, "utf-8");
	} catch (error) {
		log.debug("[promote-metrics] Failed to record decision:", error);
	}
}

/** Read every recorded decision, oldest first. Missing files yield []. */
export async function loadPromotionMetrics(): Promise<PromotionMetricRecord[]> {
	let files: string[];
	try {
		files = (await readdir(METRICS_DIR))
			.filter((file) => /^promotion-\d{4}-\d{2}\.jsonl$/.test(file))
			.sort();
	} catch (error) {
		if (!isFileNotFound(error)) throw error;
		return [];
	}

	const records: PromotionMetricRecord[] = [];
	for (const file of files) {
		const raw = await readFile(`${METRICS_DIR}/${file}`, "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as PromotionMetricRecord);
			} catch {
				// Truncated tail from a crash mid-append — skip the line.
			}
		}
	}
	return records.sort((a, b) => a.ts - b.ts);
}

export interface BarCounterfactual {
	bar: number;
	kept: number;
	/** Chunks this bar would drop that the current bar keeps. */
	newlyDropped: number;
	/** Chunks this bar would keep that the current bar drops. */
	newlyKept: number;
}

export interface SourceStats {
	total: number;
	kept: number;
	/** Count of chunks per LLM importance value, index 0 = importance 0. */
	importanceHistogram: number[];
	/** What each candidate bar would have kept, replayed from the records. */
	counterfactual: BarCounterfactual[];
}

export interface ExtractionStats {
	chunks: number;
	parseFailures: number;
	factsPerChunk: number;
	droppedFactRate: number;
	emptyExtractions: number;
}

export interface PromotionMetricsSummary {
	total: number;
	/** Attempts that came from the retry spool (a failed first attempt). */
	retries: number;
	from?: number;
	to?: number;
	bySource: Record<PromotionSource, SourceStats>;
	byModel: Record<string, ExtractionStats>;
	extraction: ExtractionStats;
}

function emptyExtractionStats(): ExtractionStats {
	return {
		chunks: 0,
		parseFailures: 0,
		factsPerChunk: 0,
		droppedFactRate: 0,
		emptyExtractions: 0,
	};
}

function extractionStats(records: PromotionMetricRecord[]): ExtractionStats {
	const stats = emptyExtractionStats();
	stats.chunks = records.length;
	let facts = 0;
	let dropped = 0;
	for (const record of records) {
		if (!record.parseOk) stats.parseFailures++;
		facts += record.factImportances.length;
		dropped += record.droppedFacts;
		if (record.parseOk && record.factImportances.length === 0) {
			stats.emptyExtractions++;
		}
	}
	stats.factsPerChunk = records.length ? facts / records.length : 0;
	stats.droppedFactRate = facts + dropped ? dropped / (facts + dropped) : 0;
	return stats;
}

/**
 * Aggregate recorded decisions. The bar counterfactual is computed by replaying
 * each record through `meetsPromotionBar`, so it reflects the real gate rather
 * than a re-implementation of it.
 */
export function summarizePromotionMetrics(
	records: PromotionMetricRecord[],
): PromotionMetricsSummary {
	const sources: PromotionSource[] = ["active", "passive"];
	const bySource = {} as Record<PromotionSource, SourceStats>;

	for (const source of sources) {
		const forSource = records.filter((record) => record.source === source);
		const counterfactual: BarCounterfactual[] = [];
		for (const bar of [1, 2, 3, 4, 5]) {
			let kept = 0;
			let newlyDropped = 0;
			let newlyKept = 0;
			for (const record of forSource) {
				if (!record.parseOk) continue;
				const would = meetsPromotionBar(record, bar, record.defaultBar);
				if (would) kept++;
				if (record.kept && !would) newlyDropped++;
				if (!record.kept && would) newlyKept++;
			}
			counterfactual.push({ bar, kept, newlyDropped, newlyKept });
		}

		const importanceHistogram = [0, 0, 0, 0, 0, 0];
		for (const record of forSource) {
			const bucket = Math.max(0, Math.min(5, Math.round(record.importance)));
			importanceHistogram[bucket] = (importanceHistogram[bucket] ?? 0) + 1;
		}

		bySource[source] = {
			total: forSource.length,
			kept: forSource.filter((record) => record.kept).length,
			importanceHistogram,
			counterfactual,
		};
	}

	const byModel: Record<string, ExtractionStats> = {};
	for (const model of new Set(records.map((record) => record.model || "?"))) {
		byModel[model] = extractionStats(
			records.filter((record) => (record.model || "?") === model),
		);
	}

	return {
		total: records.length,
		retries: records.filter((record) => record.retried).length,
		from: records[0]?.ts,
		to: records[records.length - 1]?.ts,
		bySource,
		byModel,
		extraction: extractionStats(records),
	};
}

// Extraction health watch: `promote:stats` is on-demand, but a cheap model
// quietly degrading should not wait for someone to remember to look.
const HEALTH_WINDOW_MS = 7 * 86_400_000;
const HEALTH_MIN_SAMPLE = 20;
const HEALTH_MAX_PARSE_FAILURE_RATE = 0.1;
const HEALTH_MAX_EMPTY_RATE = 0.9;

/**
 * Problems worth telling the owner about, given a window of extraction stats.
 * Only judges models with enough samples to mean anything.
 */
export function extractionHealthProblems(
	byModel: Record<string, ExtractionStats>,
): string[] {
	const problems: string[] = [];
	for (const [model, stats] of Object.entries(byModel)) {
		if (stats.chunks < HEALTH_MIN_SAMPLE) continue;
		const failureRate = stats.parseFailures / stats.chunks;
		if (failureRate > HEALTH_MAX_PARSE_FAILURE_RATE) {
			problems.push(
				`${model}: ${(failureRate * 100).toFixed(0)}% of extractions were unparseable (${stats.parseFailures}/${stats.chunks})`,
			);
		}
		const emptyRate = stats.emptyExtractions / stats.chunks;
		if (emptyRate > HEALTH_MAX_EMPTY_RATE) {
			problems.push(
				`${model}: ${(emptyRate * 100).toFixed(0)}% of extractions returned no facts at all (${stats.emptyExtractions}/${stats.chunks}) — it may have stopped pulling real data`,
			);
		}
	}
	return problems;
}

let lastHealthCheckDate = "";

/**
 * Log a rolling extraction-quality line and alert the owner when the cheap
 * background model looks like it stopped doing its job. Runs at most once a day;
 * safe to call on an hourly timer. Never throws.
 */
export async function runExtractionHealthCheck(
	alert: (key: string, message: string) => Promise<void>,
): Promise<void> {
	const today = botNow().format("YYYY-MM-DD");
	if (lastHealthCheckDate === today) return;
	lastHealthCheckDate = today;

	try {
		const cutoff = Date.now() - HEALTH_WINDOW_MS;
		const recent = (await loadPromotionMetrics()).filter(
			(record) => record.ts >= cutoff,
		);
		if (recent.length === 0) return;

		const { byModel, extraction, total } = summarizePromotionMetrics(recent);
		log.info(
			`[promote-metrics] 7d: ${total} chunks, ${extraction.parseFailures} parse failures, ` +
				`${extraction.factsPerChunk.toFixed(2)} facts/chunk, ` +
				`${(extraction.droppedFactRate * 100).toFixed(0)}% facts rejected by validation, ` +
				`${extraction.emptyExtractions} with no facts`,
		);

		const problems = extractionHealthProblems(byModel);
		for (const problem of problems) {
			log.warn(`[promote-metrics] Extraction quality: ${problem}`);
		}
		if (problems.length > 0) {
			await alert(
				"extraction-quality",
				`Background extraction quality dropped over the last 7 days:\n${problems.join("\n")}`,
			);
		}
	} catch (error) {
		log.debug("[promote-metrics] Health check failed:", error);
	}
}
