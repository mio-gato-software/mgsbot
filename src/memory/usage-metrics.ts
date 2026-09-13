import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { log } from "../logger.ts";
import { memoryPath } from "../runtime-paths.ts";
import { isFileNotFound } from "../utils.ts";

export interface TokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	reasoningTokens?: number;
}
export interface MemoryUsageRecord extends TokenUsage {
	ts: number;
	operation: string;
	model?: string;
	status: "ok" | "error";
	attempt?: number;
	fallback?: boolean;
	inputChars?: number;
	outputChars?: number;
	memoryChars?: number;
	cacheHit?: boolean;
	durationMs?: number;
}
const directory = memoryPath("metrics");
let tail = Promise.resolve();
let lastPrunedMonth = "";

/** Best-effort telemetry contains counts only, never conversation text or credentials. */
export async function recordMemoryUsage(
	record: Omit<MemoryUsageRecord, "ts">,
): Promise<void> {
	if (process.env.PROMOTION_METRICS === "false") return;
	tail = tail
		.then(async () => {
			const month = new Date().toISOString().slice(0, 7);
			await mkdir(directory, { recursive: true });
			await appendFile(
				`${directory}/usage-${month}.jsonl`,
				`${JSON.stringify({ ...record, ts: Date.now() })}\n`,
			);
			if (lastPrunedMonth === month) return;
			const configured = Number(process.env.PROMOTION_METRICS_RETENTION_MONTHS);
			const retention =
				Number.isFinite(configured) && configured > 0
					? Math.floor(configured)
					: 6;
			const files = (await readdir(directory))
				.filter((name) => /^usage-\d{4}-\d{2}\.jsonl$/.test(name))
				.sort();
			for (const name of files.slice(0, Math.max(0, files.length - retention)))
				await unlink(`${directory}/${name}`);
			lastPrunedMonth = month;
		})
		.catch((error) =>
			log.warn("[memory-usage] Could not record usage:", error),
		);
	await tail;
}

export async function loadMemoryUsage(): Promise<MemoryUsageRecord[]> {
	await tail;
	let files: string[];
	try {
		files = await readdir(directory);
	} catch (error) {
		if (isFileNotFound(error)) return [];
		throw error;
	}
	const records: MemoryUsageRecord[] = [];
	for (const name of files
		.filter((name) => /^usage-\d{4}-\d{2}\.jsonl$/.test(name))
		.sort()) {
		for (const line of (await readFile(`${directory}/${name}`, "utf8")).split(
			"\n",
		)) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				log.warn(`[memory-usage] Ignored incomplete record in ${name}`);
			}
		}
	}
	return records;
}

export function summarizeMemoryUsage(records: MemoryUsageRecord[]) {
	const groups: Record<
		string,
		{
			calls: number;
			errors: number;
			retries: number;
			fallbacks: number;
			knownTokenCalls: number;
			inputTokens: number;
			outputTokens: number;
			cachedInputTokens: number;
			reasoningTokens: number;
		}
	> = {};
	for (const record of records.filter(
		(record) => record.operation !== "prompt" && !record.cacheHit,
	)) {
		const key = `${record.operation} / ${record.model ?? "unknown"}`;
		groups[key] ??= {
			calls: 0,
			errors: 0,
			retries: 0,
			fallbacks: 0,
			knownTokenCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningTokens: 0,
		};
		const group = groups[key];
		group.calls++;
		group.errors += Number(record.status === "error");
		group.retries += Number((record.attempt ?? 1) > 1);
		group.fallbacks += Number(record.fallback === true);
		group.knownTokenCalls += Number(record.inputTokens !== undefined);
		group.inputTokens += record.inputTokens ?? 0;
		group.outputTokens += record.outputTokens ?? 0;
		group.cachedInputTokens += record.cachedInputTokens ?? 0;
		group.reasoningTokens += record.reasoningTokens ?? 0;
	}
	const embeddingLookups = records.filter(
		(record) => record.operation === "embedding" && (record.attempt ?? 1) === 1,
	);
	const prompts = records.filter((record) => record.operation === "prompt");
	return {
		groups,
		embeddingCache: {
			lookups: embeddingLookups.length,
			hits: embeddingLookups.filter((record) => record.cacheHit).length,
		},
		prompts: {
			count: prompts.length,
			averageMemoryChars: prompts.length
				? prompts.reduce((sum, record) => sum + (record.memoryChars ?? 0), 0) /
					prompts.length
				: 0,
			maxMemoryChars: prompts.reduce(
				(max, record) => Math.max(max, record.memoryChars ?? 0),
				0,
			),
		},
	};
}
