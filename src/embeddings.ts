import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});
const EMBEDDING_MODEL = "gemini-embedding-001";

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
	} catch {
		diskCache = new Map();
	}
}

function persistDiskCache(): void {
	if (!diskCacheDirty) return;
	try {
		// LRU eviction: keep the most recent entries (Map preserves insertion order)
		if (diskCache.size > MAX_CACHE_ENTRIES) {
			const entries = [...diskCache.entries()];
			diskCache = new Map(entries.slice(entries.length - MAX_CACHE_ENTRIES));
		}
		writeFileSync(CACHE_PATH, JSON.stringify([...diskCache.entries()]));
		diskCacheDirty = false;
	} catch (error) {
		console.error("[embeddings] Failed to persist cache:", error);
	}
}

// Load cache on module init
loadDiskCache();

// Persist every 60 seconds if dirty
setInterval(persistDiskCache, 60_000);

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export async function generateEmbedding(text: string): Promise<number[]> {
	const hash = hashText(text);
	const cached = diskCache.get(hash);
	if (cached) return cached;

	const response = await ai.models.embedContent({
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
}

/** Flush the embedding cache to disk immediately (e.g. on shutdown). */
export function flushEmbeddingCache(): void {
	persistDiskCache();
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
