import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { isFileNotFound } from "./utils.ts";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}
export const EMBEDDING_MODEL = "gemini-embedding-2-preview";

const isDev = process.env.NODE_ENV === "development";

const CACHE_PATH = "./memory/embedding-cache.json";
const MAX_CACHE_ENTRIES = 5000;

// Disk-persisted embedding cache: hash(text) → embedding vector
let diskCache: Map<string, number[]> = new Map();
let diskCacheDirty = false;

function loadDiskCache(): void {
	try {
		if (existsSync(CACHE_PATH)) {
			const raw = readFileSync(CACHE_PATH, "utf-8");
			const entries = JSON.parse(raw) as [string, number[]][];
			diskCache = new Map(entries);
			if (isDev)
				console.log(
					`[embeddings] Loaded ${diskCache.size} cached embeddings from disk`,
				);
		}
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[embeddings] Error loading cache:", err);
		}
		diskCache = new Map();
	}
}

async function persistDiskCache(): Promise<void> {
	if (!diskCacheDirty) return;
	try {
		// LRU eviction: keep the most recent entries (Map preserves insertion order)
		if (diskCache.size > MAX_CACHE_ENTRIES) {
			const entries = [...diskCache.entries()];
			diskCache = new Map(entries.slice(entries.length - MAX_CACHE_ENTRIES));
		}
		const tmpPath = `${CACHE_PATH}.tmp`;
		await writeFile(tmpPath, JSON.stringify([...diskCache.entries()]));
		await rename(tmpPath, CACHE_PATH);
		diskCacheDirty = false;
	} catch (error) {
		console.error("[embeddings] Failed to persist cache:", error);
	}
}

// Load cache on module init
loadDiskCache();

// Persist every 60 seconds if dirty (non-blocking)
setInterval(() => {
	persistDiskCache().catch((err) =>
		console.error("[embeddings] Persist interval error:", err),
	);
}, 60_000);

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export async function generateEmbedding(text: string): Promise<number[]> {
	const hash = hashText(text);
	const cached = diskCache.get(hash);
	if (cached) return cached;

	const MAX_RETRIES = 3;
	let lastError: unknown;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const response = await getAI().models.embedContent({
				model: EMBEDDING_MODEL,
				contents: text,
			});

			const embedding = response.embeddings?.[0]?.values;
			if (!embedding) {
				throw new Error("No embedding returned from API");
			}

			diskCache.set(hash, embedding);
			diskCacheDirty = true;
			if (isDev)
				console.log(
					`[embeddings] Generated embedding for: "${text.slice(0, 60)}..."`,
				);
			return embedding;
		} catch (err: unknown) {
			lastError = err;
			const status =
				err instanceof Error && "status" in err
					? (err as { status: number }).status
					: undefined;
			if (status === 429 && attempt < MAX_RETRIES - 1) {
				const delay = 1000 * 2 ** attempt;
				if (isDev)
					console.warn(
						`[embeddings] Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
					);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			throw err;
		}
	}

	throw lastError;
}

/** Flush the embedding cache to disk immediately (e.g. on shutdown). */
export async function flushEmbeddingCache(): Promise<void> {
	await persistDiskCache();
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
	const results: number[][] = [];
	// Process in batches to avoid rate limits
	const BATCH_SIZE = 10;

	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((text) => generateEmbedding(text)),
		);
		results.push(...batchResults);
	}

	return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dotProduct / denominator;
}

export function findMostSimilar(
	query: number[],
	candidates: { embedding: number[] }[],
	threshold = 0.5,
): { index: number; score: number }[] {
	const scored = candidates
		.map((candidate, index) => ({
			index,
			score: cosineSimilarity(query, candidate.embedding),
		}))
		.filter((item) => item.score >= threshold);

	scored.sort((a, b) => b.score - a.score);
	return scored;
}
