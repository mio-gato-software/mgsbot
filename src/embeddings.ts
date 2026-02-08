import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});
const EMBEDDING_MODEL = "gemini-embedding-001";

const isDev = process.env.NODE_ENV === "development";

// In-memory cache to avoid re-embedding the same text in a session
const embeddingCache = new Map<string, number[]>();

export async function generateEmbedding(text: string): Promise<number[]> {
	const cached = embeddingCache.get(text);
	if (cached) return cached;

	const response = await ai.models.embedContent({
		model: EMBEDDING_MODEL,
		contents: text,
	});

	const embedding = response.embeddings?.[0]?.values;
	if (!embedding) {
		throw new Error("No embedding returned from API");
	}

	embeddingCache.set(text, embedding);
	if (isDev)
		console.log(
			`[embeddings] Generated embedding for: "${text.slice(0, 60)}..."`,
		);
	return embedding;
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
