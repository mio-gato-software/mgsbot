import { generateEmbedding } from "../embeddings.ts";
import type { ConversationMessage } from "../types.ts";

export function normalizeName(name: string): string {
	return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.split(/\s+/)
			.filter((t) => t.length > 1),
	);
}

/**
 * Compute keyword overlap score between query and candidate text.
 * Returns 0–1: fraction of query tokens found in candidate.
 */
export function computeTextScore(query: string, candidate: string): number {
	const queryTokens = tokenize(query);
	if (queryTokens.size === 0) return 0;
	const candidateTokens = tokenize(candidate);
	let matches = 0;
	for (const token of queryTokens) {
		if (candidateTokens.has(token)) matches++;
	}
	return matches / queryTokens.size;
}

/**
 * Generate a query embedding from recent messages for retrieval.
 * Returns the embedding and the raw text used (for hybrid keyword scoring).
 */
export async function getQueryEmbedding(
	messages: ConversationMessage[],
): Promise<{ embedding: number[]; text: string }> {
	const recentText = messages
		.slice(-3)
		.map((m) => m.content)
		.join(" ");
	const embedding = await generateEmbedding(recentText);
	return { embedding, text: recentText };
}
