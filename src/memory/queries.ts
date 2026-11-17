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
 * Keep recent text for participant and keyword scoring. A turn-specific query
 * can focus the embedding on the latest user message.
 */
export async function getQueryEmbedding(
	messages: ConversationMessage[],
	queryText?: string,
): Promise<{ embedding: number[]; text: string }> {
	const recentText = messages
		.slice(-3)
		.map((m) => m.content)
		.join(" ");
	const embedding = await generateEmbedding(queryText || recentText);
	return { embedding, text: recentText };
}

const MONTH_NAMES = [
	["january", "enero"],
	["february", "febrero"],
	["march", "marzo"],
	["april", "abril"],
	["may", "mayo"],
	["june", "junio"],
	["july", "julio"],
	["august", "agosto"],
	["september", "septiembre", "setiembre"],
	["october", "octubre"],
	["november", "noviembre"],
	["december", "diciembre"],
];

/** Match calendar references for ranking stored memories. */
export function memoryMonthMatcher(
	queryText: string,
): (month: string) => boolean {
	const query = normalizeName(queryText);
	const words = new Set(query.split(/[^a-z0-9]+/));
	const years: string[] = query.match(/\b(?:19|20)\d{2}\b/g) ?? [];
	const dates: string[] = query.match(/\b\d{4}-\d{2}\b/g) ?? [];
	const months = MONTH_NAMES.flatMap((names, index) =>
		names.some((name) => words.has(name))
			? [String(index + 1).padStart(2, "0")]
			: [],
	);
	return (value) => {
		const [year = "", month = ""] = value.split("-");
		return (
			dates.includes(value) ||
			(months.includes(month) && (!years.length || years.includes(year))) ||
			(!months.length && !dates.length && years.includes(year))
		);
	};
}

/** Historical facts and conversational recall use the same relevance floor. */
export function hasRecallEvidence(
	similarity: number,
	keywordScore: number,
): boolean {
	return similarity >= 0.45 || keywordScore >= 0.15;
}
