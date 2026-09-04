import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { getOpenAIClient } from "./ai/openai-client.ts";
import {
	resolveEmbeddingDim,
	resolveEmbeddingModel,
	resolveEmbeddingProvider,
} from "./ai/platform.ts";
import { log } from "./logger.ts";
import { memoryPath } from "./runtime-paths.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}

export function getEmbeddingModel(): string {
	return resolveEmbeddingModel();
}

export function getEmbeddingDim(): number {
	return resolveEmbeddingDim();
}

const CACHE_PATH = memoryPath("embedding-cache.json");
const MAX_CACHE_ENTRIES = 5000;

let diskCache: Map<string, number[]> = new Map();
let diskCacheDirty = false;
let cacheRevision = 0;
let cacheLoaded = false;
let persistTail = Promise.resolve();

export function initEmbeddingCache(): void {
	if (cacheLoaded) return;
	cacheLoaded = true;
	try {
		if (existsSync(CACHE_PATH)) {
			const raw = readFileSync(CACHE_PATH, "utf-8");
			const entries = JSON.parse(raw) as [string, number[]][];
			diskCache = new Map(entries);
			log.debug(
				`[embeddings] Loaded ${diskCache.size} cached embeddings from disk`,
			);
		}
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[embeddings] Error loading cache:", err);
		}
		diskCache = new Map();
	}
}

async function persistDiskCache(): Promise<void> {
	if (!diskCacheDirty) return;
	try {
		if (diskCache.size > MAX_CACHE_ENTRIES) {
			const entries = [...diskCache.entries()];
			diskCache = new Map(entries.slice(entries.length - MAX_CACHE_ENTRIES));
		}
		const revision = cacheRevision;
		await atomicWriteFile(CACHE_PATH, JSON.stringify([...diskCache.entries()]));
		if (cacheRevision === revision) diskCacheDirty = false;
	} catch (error) {
		log.error("[embeddings] Failed to persist cache:", error);
	}
}

function hashText(text: string): string {
	// Include model+dim so a provider/model switch cannot reuse stale vectors.
	// Existing cache entries from before this prefix become unreachable and
	// age out via LRU.
	return createHash("sha256")
		.update(`${getEmbeddingModel()}:${getEmbeddingDim()}:${text}`)
		.digest("hex");
}

async function embedWithGemini(text: string): Promise<number[]> {
	const response = await getAI().models.embedContent({
		model: getEmbeddingModel(),
		contents: text,
		config: { outputDimensionality: getEmbeddingDim() },
	});
	const embedding = response.embeddings?.[0]?.values;
	if (!embedding) throw new Error("No embedding returned from Gemini");
	return embedding;
}

async function embedWithOpenAI(text: string): Promise<number[]> {
	const response = await getOpenAIClient().embeddings.create({
		model: getEmbeddingModel(),
		input: text,
		dimensions: getEmbeddingDim(),
		encoding_format: "float",
	});
	const embedding = response.data[0]?.embedding;
	if (!embedding) throw new Error("No embedding returned from OpenAI");
	return embedding;
}

export async function generateEmbedding(text: string): Promise<number[]> {
	initEmbeddingCache();
	const hash = hashText(text);
	const cached = diskCache.get(hash);
	if (cached) {
		diskCache.delete(hash);
		diskCache.set(hash, cached);
		return cached;
	}

	const MAX_RETRIES = 3;
	let lastError: unknown;
	const provider = resolveEmbeddingProvider();

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const embedding =
				provider === "openai"
					? await embedWithOpenAI(text)
					: await embedWithGemini(text);

			diskCache.set(hash, embedding);
			diskCacheDirty = true;
			cacheRevision++;
			log.debug(
				`[embeddings:${provider}] Generated embedding for: "${text.slice(0, 60)}..."`,
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
				log.debug(
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

export async function flushEmbeddingCache(): Promise<void> {
	persistTail = persistTail.then(persistDiskCache);
	await persistTail;
}

export async function clearEmbeddingCache(): Promise<void> {
	cacheLoaded = true;
	diskCache = new Map();
	diskCacheDirty = true;
	cacheRevision++;
	persistTail = persistTail.then(persistDiskCache);
	await persistTail;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
	const results: number[][] = [];
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
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dotProduct += x * y;
		normA += x * x;
		normB += y * y;
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
