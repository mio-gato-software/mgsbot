import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cosineSimilarity } from "../embeddings.ts";
import { getAllAliasesForCanonical } from "../identities.ts";
import type { SemanticFact } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { computeTextScore, normalizeName } from "./queries.ts";

export const SEMANTIC_PATH = "./memory/semantic.json";

const SEMANTIC_DEDUP_THRESHOLD = 0.85;
const CONFIDENCE_DECAY_RATE = 0.02; // Per day
const MIN_CONFIDENCE = 0.1;
const MAX_PERMANENT_FACTS = 25;

const isDev = process.env.NODE_ENV === "development";

let semanticCache: SemanticFact[] | null = null;
let semanticLastMtimeMs = 0;

export async function loadSemanticStore(): Promise<SemanticFact[]> {
	try {
		const stat = statSync(SEMANTIC_PATH);
		if (semanticCache && stat.mtimeMs === semanticLastMtimeMs) {
			return semanticCache;
		}
		const data = await readFile(SEMANTIC_PATH, "utf-8");
		semanticCache = JSON.parse(data) as SemanticFact[];
		semanticLastMtimeMs = stat.mtimeMs;
		return semanticCache;
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[memory] Error loading semantic store:", err);
		}
		semanticCache = [];
		return [];
	}
}

export async function saveSemanticStore(facts: SemanticFact[]): Promise<void> {
	semanticCache = facts;
	await atomicWriteFile(SEMANTIC_PATH, JSON.stringify(facts, null, 2));
	// Update mtime to match what we just wrote
	try {
		semanticLastMtimeMs = statSync(SEMANTIC_PATH).mtimeMs;
	} catch {
		// ignore — stat after write is non-critical
	}
}

export async function addSemanticFacts(
	newFacts: SemanticFact[],
): Promise<void> {
	const store = await loadSemanticStore();
	const now = Date.now();

	for (const newFact of newFacts) {
		// Find similar existing facts by embedding
		let merged = false;
		for (const existing of store) {
			const similarity = cosineSimilarity(
				newFact.embedding,
				existing.embedding,
			);
			// Use lower threshold for same-subject person facts (catch more duplicates)
			const isSamePersonSubject =
				newFact.category === "person" &&
				existing.category === "person" &&
				newFact.subject &&
				existing.subject &&
				normalizeName(newFact.subject) === normalizeName(existing.subject);
			const threshold = isSamePersonSubject ? 0.8 : SEMANTIC_DEDUP_THRESHOLD;
			if (similarity >= threshold) {
				// Update existing: refresh confidence and timestamp
				existing.lastConfirmed = now;
				existing.confidence = Math.min(1, existing.confidence + 0.2);
				// Update content if new fact has higher importance
				if (newFact.importance > existing.importance) {
					existing.content = newFact.content;
					existing.context = newFact.context;
					existing.importance = newFact.importance;
					existing.embedding = newFact.embedding;
				}
				// Promote to permanent if new fact is permanent and cap allows
				if (newFact.permanent && !existing.permanent) {
					const permanentCount = store.filter((f) => f.permanent).length;
					if (permanentCount < MAX_PERMANENT_FACTS) {
						existing.permanent = true;
						if (isDev)
							console.log(
								`[semantic] Promoted to permanent: "${existing.content.slice(0, 60)}"`,
							);
					}
				}
				merged = true;
				if (isDev)
					console.log(
						`[semantic] Merged duplicate (similarity=${similarity.toFixed(2)}): "${newFact.content.slice(0, 60)}"`,
					);
				break;
			}
		}

		if (!merged) {
			// Enforce permanent fact cap
			if (newFact.permanent) {
				const permanentCount = store.filter((f) => f.permanent).length;
				if (permanentCount >= MAX_PERMANENT_FACTS) {
					if (isDev)
						console.log(
							`[semantic] Permanent fact cap reached (${MAX_PERMANENT_FACTS}), skipping: "${newFact.content.slice(0, 60)}"`,
						);
					continue;
				}
			}
			store.push(newFact);
			if (isDev)
				console.log(
					`[semantic] Added new ${newFact.permanent ? "permanent " : ""}fact: "${newFact.content.slice(0, 60)}"`,
				);
		}
	}

	await saveSemanticStore(store);
}

export async function getRelevantFacts(
	queryEmbedding: number[],
	options?: {
		category?: SemanticFact["category"];
		subject?: string;
		maxCount?: number;
		queryText?: string;
	},
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	if (store.length === 0) return [];

	const maxCount = options?.maxCount ?? 15;
	const now = Date.now();

	// Exclude permanent facts (they are always included separately)
	let candidates = store.filter((f) => !f.permanent);

	// Filter by category if specified
	if (options?.category) {
		candidates = candidates.filter((f) => f.category === options.category);
	}

	// Filter by subject if specified
	if (options?.subject) {
		const normalizedSubject = normalizeName(options.subject);
		candidates = candidates.filter(
			(f) => f.subject && normalizeName(f.subject) === normalizedSubject,
		);
	}

	const scored = candidates.map((fact) => {
		const similarity = cosineSimilarity(queryEmbedding, fact.embedding);
		const keywordScore = options?.queryText
			? computeTextScore(options.queryText, fact.content)
			: 0;
		const importanceScore = (fact.importance - 1) / 4;
		const daysSinceConfirmed = (now - fact.lastConfirmed) / 86_400_000;
		const recencyScore = Math.exp(-daysSinceConfirmed / 14); // Half-life ~10 days

		// 40% semantic similarity, 15% keyword, 20% importance, 15% confidence, 10% recency
		const score =
			0.4 * similarity +
			0.15 * keywordScore +
			0.2 * importanceScore +
			0.15 * fact.confidence +
			0.1 * recencyScore;

		return { fact, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, maxCount).map((s) => s.fact);
}

/**
 * Get all facts for specific subjects (for prompt building).
 * No embedding query needed — returns all facts for the given names.
 */
export async function getFactsForSubjects(
	names: string[],
	maxPerSubject = 10,
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();

	// Expand each name to include all known aliases from identity registry
	const allAliases = new Set<string>();
	for (const name of names) {
		const aliases = await getAllAliasesForCanonical(name);
		for (const alias of aliases) {
			allAliases.add(alias);
		}
	}

	const matching = store.filter(
		(f) =>
			!f.permanent &&
			f.category === "person" &&
			f.subject &&
			allAliases.has(normalizeName(f.subject)),
	);

	// Cap per subject: keep highest importance facts for each
	const bySubject = new Map<string, SemanticFact[]>();
	for (const fact of matching) {
		const key = normalizeName(fact.subject ?? "");
		const list = bySubject.get(key) ?? [];
		list.push(fact);
		bySubject.set(key, list);
	}

	const result: SemanticFact[] = [];
	for (const facts of bySubject.values()) {
		facts.sort((a, b) => b.importance - a.importance);
		result.push(...facts.slice(0, maxPerSubject));
	}
	return result;
}

export async function getPermanentFacts(): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	return store.filter((f) => f.permanent === true);
}

let lastDecayDate = "";

export async function decayConfidence(): Promise<{
	total: number;
	removed: number;
}> {
	const today = new Date().toISOString().slice(0, 10);
	if (lastDecayDate === today) {
		const store = await loadSemanticStore();
		return { total: store.length, removed: 0 };
	}

	const store = await loadSemanticStore();
	const totalBefore = store.length;
	const now = Date.now();

	for (const fact of store) {
		if (fact.permanent) continue;
		const daysSinceConfirmed = (now - fact.lastConfirmed) / 86_400_000;
		fact.confidence = Math.max(
			0,
			fact.confidence - CONFIDENCE_DECAY_RATE * daysSinceConfirmed,
		);
	}

	// Remove facts below minimum confidence (preserve permanent)
	const filtered = store.filter(
		(f) => f.permanent || f.confidence >= MIN_CONFIDENCE,
	);
	const removed = totalBefore - filtered.length;

	if (removed > 0 && isDev) {
		console.log(`[semantic] Decayed confidence: removed ${removed} facts`);
	}

	await saveSemanticStore(filtered);
	lastDecayDate = today;

	return { total: filtered.length, removed };
}
