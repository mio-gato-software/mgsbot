import { createHash } from "node:crypto";
import { z } from "zod";
import { type FactRetirement, reviewFactCluster } from "./ai/evaluation.ts";
import { log } from "./logger.ts";
import { withSemanticLock } from "./memory/locks.ts";
import { normalizeName } from "./memory/queries.ts";
import {
	isFactActive,
	loadSemanticStore,
	saveSemanticStore,
} from "./memory/semantic.ts";
import { readStore, writeStore } from "./memory/storage.ts";
import { memoryPath } from "./runtime-paths.ts";
import type { SemanticFact } from "./types.ts";

// Contradiction repair depends on the extractor having seen the old fact in
// its bounded dedup context; paraphrased contradictions slip through and
// coexist. This janitor periodically reviews clusters of same-subject facts
// with the background model and soft-retires the losers (supersededBy +
// validUntil — never hard deletion, never permanent facts).

// Only clusters this large get reviewed — small stores don't have enough
// same-subject facts for contradictions to bite, so the janitor is a no-op.
const MIN_CLUSTER_SIZE = 6;
const MAX_CLUSTERS_PER_RUN = 5;
const MAX_FACTS_PER_CLUSTER = 30;

/** Sentinel supersededBy for janitor retirements without a named successor. */
const JANITOR_RETIRED = "janitor";

export function clusterFactsBySubject(
	store: SemanticFact[],
	now = Date.now(),
): Map<string, SemanticFact[]> {
	const clusters = new Map<string, SemanticFact[]>();
	for (const fact of store) {
		if (
			fact.permanent ||
			fact.archivedAt ||
			!fact.subject ||
			!isFactActive(fact, now)
		)
			continue;
		const key = `${fact.category}:${normalizeName(fact.subject)}`;
		const list = clusters.get(key) ?? [];
		list.push(fact);
		clusters.set(key, list);
	}
	return clusters;
}

/**
 * Apply reviewed retirements to the store in place. Only facts that were part
 * of the reviewed cluster can be retired (the LLM can't invent ids outside
 * it), and permanent or already-retired facts are never touched.
 * Returns the number of facts retired.
 */
export function applyFactRetirements(
	store: SemanticFact[],
	reviewedIds: Set<string>,
	retirements: FactRetirement[],
	now = Date.now(),
): number {
	const byId = new Map(store.map((fact) => [fact.id, fact]));
	let retired = 0;
	for (const retirement of retirements) {
		if (!reviewedIds.has(retirement.id)) continue;
		const fact = byId.get(retirement.id);
		if (!fact || fact.permanent || !isFactActive(fact, now)) continue;
		const successor = retirement.supersededBy
			? byId.get(retirement.supersededBy)
			: undefined;
		const hasValidSuccessor =
			!!successor && successor.id !== fact.id && isFactActive(successor, now);
		fact.supersededBy = hasValidSuccessor ? successor.id : JANITOR_RETIRED;
		fact.validUntil = now;
		fact.confidence = Math.min(fact.confidence, 0.2);
		retired++;
		log.debug(
			`[janitor] Retired fact ${fact.id} (${retirement.reason || "no reason"}): "${fact.content.slice(0, 60)}"`,
		);
	}
	return retired;
}

let lastJanitorDate = "";
const REVIEW_STATE_PATH = memoryPath("janitor-reviews.json");
const reviewStateSchema = z.record(z.string(), z.string());
export function factClusterFingerprint(facts: SemanticFact[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				facts
					.map((fact) => [
						fact.id,
						fact.content,
						fact.lastConfirmed,
						fact.importance,
					])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
			),
		)
		.digest("hex");
}

/**
 * Daily maintenance pass over the semantic store: for each subject with
 * enough active facts, one background-model review merges/retires
 * contradictions and duplicates that embedding-based dedup missed.
 * Gated to run at most once per day per process.
 */
export async function runSemanticJanitor(
	options: { now?: number; review?: typeof reviewFactCluster } = {},
): Promise<{
	clustersReviewed: number;
	factsRetired: number;
}> {
	const now = options.now ?? Date.now();
	const today = new Date(now).toISOString().slice(0, 10);
	if (lastJanitorDate === today) {
		return { clustersReviewed: 0, factsRetired: 0 };
	}
	lastJanitorDate = today;

	const store = await loadSemanticStore();
	const reviewed: Record<string, string> = await readStore(
		REVIEW_STATE_PATH,
		reviewStateSchema,
		() => ({}),
	);
	const clusters = [...clusterFactsBySubject(store, now).entries()]
		.filter(
			([key, facts]) =>
				facts.length >= MIN_CLUSTER_SIZE &&
				reviewed[key] !== factClusterFingerprint(facts),
		)
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, MAX_CLUSTERS_PER_RUN);

	let clustersReviewed = 0;
	let factsRetired = 0;

	for (const [key, facts] of clusters) {
		const candidates = facts
			.slice()
			.sort(
				(a, b) =>
					(b.lastConfirmed ?? b.createdAt) - (a.lastConfirmed ?? a.createdAt),
			)
			.slice(0, MAX_FACTS_PER_CLUSTER);

		let retirements: FactRetirement[];
		try {
			retirements = await (options.review ?? reviewFactCluster)({
				subject: candidates[0]?.subject ?? key,
				facts: candidates.map((fact) => ({
					id: fact.id,
					content: fact.content,
					createdAt: fact.createdAt,
					importance: fact.importance,
				})),
			});
		} catch (err) {
			log.warn(`[janitor] Review failed for cluster ${key}:`, err);
			continue;
		}
		clustersReviewed++;

		const reviewedIds = new Set(candidates.map((fact) => fact.id));
		await withSemanticLock(async () => {
			// Re-read inside the lock: promotions may have changed the store
			// while the LLM call was in flight.
			const freshStore = await loadSemanticStore();
			const clusterUnchanged =
				factClusterFingerprint(
					clusterFactsBySubject(freshStore, now).get(key) ?? [],
				) === factClusterFingerprint(facts);
			// Do not apply a stale review to facts changed while the model was running.
			const unchangedIds = new Set(
				freshStore
					.filter((fact) =>
						candidates.some(
							(candidate) =>
								candidate.id === fact.id &&
								factClusterFingerprint([candidate]) ===
									factClusterFingerprint([fact]),
						),
					)
					.map((fact) => fact.id)
					.filter((id) => reviewedIds.has(id)),
			);
			const retired = applyFactRetirements(
				freshStore,
				unchangedIds,
				retirements,
			);
			if (retired > 0) {
				factsRetired += retired;
				await saveSemanticStore(freshStore);
			}
			reviewed[key] = clusterUnchanged
				? factClusterFingerprint(
						clusterFactsBySubject(freshStore, now).get(key) ?? [],
					)
				: factClusterFingerprint(facts);
		});
	}

	if (clustersReviewed > 0) {
		await writeStore(REVIEW_STATE_PATH, reviewed, reviewStateSchema, true);
		log.info(
			`[janitor] Reviewed ${clustersReviewed} cluster(s), retired ${factsRetired} fact(s)`,
		);
	}
	return { clustersReviewed, factsRetired };
}
