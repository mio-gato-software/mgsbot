import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cosineSimilarity, getEmbeddingModel } from "../embeddings.ts";
import { getAllAliasesForCanonical } from "../identities.ts";
import { log } from "../logger.ts";
import type { SemanticFact } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { withSemanticLock } from "./locks.ts";
import { computeTextScore, normalizeName } from "./queries.ts";
import { unwrapVersioned, wrapVersioned } from "./versioning.ts";

export const SEMANTIC_PATH = "./memory/semantic.json";

const SEMANTIC_DEDUP_THRESHOLD = 0.85;
const CONFIDENCE_DECAY_RATE = 0.02; // Per day
const MIN_CONFIDENCE = 0.1;
const MAX_PERMANENT_FACTS = 25;
const MAX_DEDUP_FACTS = 30;
// Retrieval reinforcement: throttle so an active conversation doesn't rewrite
// the store on every message, and bump gently (dedup reconfirm uses +0.2).
const REINFORCEMENT_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REINFORCEMENT_CONFIDENCE_BUMP = 0.05;
// Retrieval says a fact is *useful*, not that it is *true*: being recalled a
// lot must not turn into certainty. Two guards keep repetition from
// impersonating evidence:
//  1. A ceiling — retrieval alone can only hold a fact at this confidence.
//     Going above it requires genuine reconfirmation in conversation (the
//     dedup merge path, which is the only thing that moves lastConfirmed).
//  2. The ceiling itself erodes as that last real confirmation ages, so a fact
//     the bot keeps quoting back to itself still decays out of the store
//     instead of becoming immortal.
export const REINFORCEMENT_CONFIDENCE_CEILING = 0.75;
export const REINFORCEMENT_CEILING_EROSION_PER_DAY = 0.01;

let semanticCache: SemanticFact[] | null = null;
let semanticLastMtimeMs = 0;

function getEmbeddingDim(fact: SemanticFact): number {
	return fact.embeddingDim ?? fact.embedding.length;
}

function canCompareEmbedding(
	queryEmbedding: number[],
	fact: SemanticFact,
): boolean {
	return queryEmbedding.length === getEmbeddingDim(fact);
}

function inferDefaultScope(fact: SemanticFact): SemanticFact["scope"] {
	if (fact.scope) return fact.scope;
	if (fact.category === "person") return "person";
	if (fact.sourceChatId !== undefined) return "chat";
	return "global";
}

function normalizeFactShape(fact: SemanticFact): SemanticFact {
	fact.embeddingDim = getEmbeddingDim(fact);
	fact.scope = inferDefaultScope(fact);
	return fact;
}

export function isFactActive(fact: SemanticFact, now = Date.now()): boolean {
	return !fact.supersededBy && (!fact.validUntil || fact.validUntil > now);
}

function applySupersession(
	store: SemanticFact[],
	newFact: SemanticFact,
	replacementId: string,
	now: number,
): void {
	if (!newFact.supersedes?.length) return;
	const supersededIds = new Set(newFact.supersedes);
	for (const existing of store) {
		if (!supersededIds.has(existing.id) || existing.permanent) continue;
		existing.supersededBy = replacementId;
		existing.validUntil = now;
		existing.confidence = Math.min(existing.confidence, 0.2);
	}
}

function findDedupCandidates(
	store: SemanticFact[],
	newFact: SemanticFact,
): SemanticFact[] {
	const sameSubject = store.filter(
		(existing) =>
			isFactActive(existing) &&
			existing.category === newFact.category &&
			existing.subject &&
			newFact.subject &&
			normalizeName(existing.subject) === normalizeName(newFact.subject),
	);
	if (sameSubject.length >= MAX_DEDUP_FACTS) {
		return sameSubject
			.sort((a, b) => b.importance - a.importance)
			.slice(0, MAX_DEDUP_FACTS);
	}

	const sameCategory = store
		.filter(
			(existing) =>
				isFactActive(existing) &&
				existing.category === newFact.category &&
				(newFact.sourceChatId === undefined ||
					existing.sourceChatId === undefined ||
					existing.sourceChatId === newFact.sourceChatId),
		)
		.sort((a, b) => {
			const aTime = a.lastConfirmed ?? a.createdAt;
			const bTime = b.lastConfirmed ?? b.createdAt;
			return b.importance - a.importance || bTime - aTime;
		})
		.slice(0, MAX_DEDUP_FACTS - sameSubject.length);

	const seen = new Set(sameSubject.map((fact) => fact.id));
	return [
		...sameSubject,
		...sameCategory.filter((fact) => !seen.has(fact.id)),
	].slice(0, MAX_DEDUP_FACTS);
}

export async function loadSemanticStore(): Promise<SemanticFact[]> {
	try {
		const stat = statSync(SEMANTIC_PATH);
		if (semanticCache && stat.mtimeMs === semanticLastMtimeMs) {
			return semanticCache;
		}
		const data = await readFile(SEMANTIC_PATH, "utf-8");
		semanticCache = unwrapVersioned<SemanticFact[]>(JSON.parse(data)).map(
			normalizeFactShape,
		);
		semanticLastMtimeMs = stat.mtimeMs;
		return semanticCache;
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[memory] Error loading semantic store:", err);
		}
		semanticCache = [];
		return [];
	}
}

export async function saveSemanticStore(facts: SemanticFact[]): Promise<void> {
	semanticCache = facts;
	await atomicWriteFile(
		SEMANTIC_PATH,
		JSON.stringify(wrapVersioned(facts), null, 2),
	);
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
	await withSemanticLock(async () => {
		const store = await loadSemanticStore();
		const now = Date.now();

		for (const rawNewFact of newFacts) {
			const newFact = normalizeFactShape(rawNewFact);
			newFact.embeddingModel ??= getEmbeddingModel();
			newFact.embeddingDim = newFact.embedding.length;
			newFact.scope = inferDefaultScope(newFact);

			// Find similar existing facts by embedding
			let merged = false;
			for (const existing of findDedupCandidates(store, newFact)) {
				if (!canCompareEmbedding(newFact.embedding, existing)) continue;
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
					existing.lastDecayedAt = now;
					existing.confidence = Math.min(1, existing.confidence + 0.2);
					// Update content if new fact has higher importance
					if (newFact.importance > existing.importance) {
						existing.content = newFact.content;
						existing.context = newFact.context;
						existing.importance = newFact.importance;
						existing.embedding = newFact.embedding;
						existing.embeddingModel = newFact.embeddingModel;
						existing.embeddingDim = newFact.embeddingDim;
						existing.scope = newFact.scope;
						existing.sourceChatId ??= newFact.sourceChatId;
					}
					applySupersession(store, newFact, existing.id, now);
					// Promote to permanent if new fact is permanent and cap allows
					if (newFact.permanent && !existing.permanent) {
						const permanentCount = store.filter((f) => f.permanent).length;
						if (permanentCount < MAX_PERMANENT_FACTS) {
							existing.permanent = true;
							log.debug(
								`[semantic] Promoted to permanent: "${existing.content.slice(0, 60)}"`,
							);
						}
					}
					merged = true;
					log.debug(
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
						log.debug(
							`[semantic] Permanent fact cap reached (${MAX_PERMANENT_FACTS}), skipping: "${newFact.content.slice(0, 60)}"`,
						);
						continue;
					}
				}
				store.push(newFact);
				applySupersession(store, newFact, newFact.id, now);
				log.debug(
					`[semantic] Added new ${newFact.permanent ? "permanent " : ""}fact: "${newFact.content.slice(0, 60)}"`,
				);
			}
		}

		await saveSemanticStore(store);
	});
}

export async function getRelevantExistingFactsForDedup(
	newFactDrafts: Array<{
		content: string;
		category: SemanticFact["category"];
		subject?: string;
		sourceChatId?: number;
	}>,
	maxCount = MAX_DEDUP_FACTS,
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	const selected = new Map<string, SemanticFact>();

	for (const draft of newFactDrafts) {
		const draftFact: SemanticFact = {
			id: "draft",
			content: draft.content,
			category: draft.category,
			subject: draft.subject,
			embedding: [],
			importance: 1,
			confidence: 1,
			createdAt: Date.now(),
			lastConfirmed: Date.now(),
			sourceChatId: draft.sourceChatId,
		};

		for (const fact of findDedupCandidates(store, draftFact)) {
			selected.set(fact.id, fact);
			if (selected.size >= maxCount) break;
		}
		if (selected.size >= maxCount) break;
	}

	if (selected.size === 0) {
		return store
			.slice()
			.sort((a, b) => b.importance - a.importance)
			.slice(0, Math.min(10, maxCount));
	}

	return [...selected.values()];
}

export async function getRelevantFacts(
	queryEmbedding: number[],
	options?: {
		category?: SemanticFact["category"];
		subject?: string;
		maxCount?: number;
		queryText?: string;
		chatId?: number;
	},
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	if (store.length === 0) return [];

	const maxCount = options?.maxCount ?? 15;
	const now = Date.now();

	// Exclude permanent facts (they are always included separately)
	let candidates = store.filter((f) => !f.permanent);
	candidates = candidates.filter((f) => isFactActive(f, now));

	if (options?.chatId !== undefined) {
		candidates = candidates.filter(
			(f) => f.scope !== "chat" || f.sourceChatId === options.chatId,
		);
	}

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
		const similarity = canCompareEmbedding(queryEmbedding, fact)
			? cosineSimilarity(queryEmbedding, fact.embedding)
			: 0;
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
			isFactActive(f) &&
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

/**
 * Highest confidence retrieval alone may push a fact to. Starts at the ceiling
 * and erodes with the age of the last genuine confirmation, so repetition buys
 * a recalled fact time but never permanence.
 */
export function reinforcementCeiling(
	fact: SemanticFact,
	now = Date.now(),
): number {
	const daysSinceConfirmed = Math.max(
		0,
		(now - fact.lastConfirmed) / 86_400_000,
	);
	return Math.max(
		0,
		REINFORCEMENT_CONFIDENCE_CEILING -
			REINFORCEMENT_CEILING_EROSION_PER_DAY * daysSinceConfirmed,
	);
}

/**
 * Apply retrieval reinforcement to the given facts in place: a fact that was
 * actually injected into a prompt gets a small confidence bump, capped by
 * `reinforcementCeiling`, so often-recalled memories fade more slowly without
 * repetition being mistaken for truth. Deliberately does NOT touch
 * `lastConfirmed` or `lastDecayedAt` — daily decay keeps running on recalled
 * facts, and only real reconfirmation resets those clocks.
 * Facts recalled within the last hour are skipped (write throttle).
 * Returns the number of facts changed.
 */
export function applyRetrievalReinforcement(
	store: SemanticFact[],
	factIds: string[],
	now = Date.now(),
): number {
	const ids = new Set(factIds);
	let changed = 0;
	for (const fact of store) {
		if (!ids.has(fact.id) || fact.permanent || !isFactActive(fact, now)) {
			continue;
		}
		const lastRecalled = fact.lastRecalledAt ?? fact.lastConfirmed;
		if (now - lastRecalled < REINFORCEMENT_MIN_INTERVAL_MS) continue;
		fact.lastRecalledAt = now;
		const ceiling = reinforcementCeiling(fact, now);
		if (fact.confidence < ceiling) {
			fact.confidence = Math.min(
				ceiling,
				fact.confidence + REINFORCEMENT_CONFIDENCE_BUMP,
			);
		}
		changed++;
	}
	return changed;
}

export async function reinforceRecalledFacts(factIds: string[]): Promise<void> {
	if (factIds.length === 0) return;
	await withSemanticLock(async () => {
		const store = await loadSemanticStore();
		if (applyRetrievalReinforcement(store, factIds) > 0) {
			await saveSemanticStore(store);
		}
	});
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

	return withSemanticLock(async () => {
		const store = await loadSemanticStore();
		const totalBefore = store.length;
		const now = Date.now();

		for (const fact of store) {
			normalizeFactShape(fact);
			if (fact.permanent) continue;
			const decayReference = fact.lastDecayedAt ?? fact.lastConfirmed;
			const daysSinceDecay = Math.max(0, (now - decayReference) / 86_400_000);
			fact.confidence = Math.max(
				0,
				fact.confidence - CONFIDENCE_DECAY_RATE * daysSinceDecay,
			);
			fact.lastDecayedAt = now;
		}

		// Remove facts below minimum confidence (preserve permanent)
		const filtered = store.filter(
			(f) => f.permanent || f.confidence >= MIN_CONFIDENCE,
		);
		const removed = totalBefore - filtered.length;

		if (removed > 0) {
			log.debug(`[semantic] Decayed confidence: removed ${removed} facts`);
		}

		await saveSemanticStore(filtered);
		lastDecayDate = today;

		return { total: filtered.length, removed };
	});
}
