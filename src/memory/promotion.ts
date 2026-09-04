import { createHash } from "node:crypto";
import {
	ExtractionParseError,
	evaluateConversationChunk,
	generateLongTermMemoryUpdate,
} from "../ai/evaluation.ts";
import { alertOwner } from "../alerts.ts";
import { botNow } from "../bot-time.ts";
import { generateEmbedding, getEmbeddingModel } from "../embeddings.ts";
import { resolveCanonicalName } from "../identities.ts";
import { log } from "../logger.ts";
import { applyPersonalitySignals } from "../personality.ts";
import type {
	ConversationMessage,
	PromotionResult,
	SemanticFact,
} from "../types.ts";
import {
	addEpisode,
	addSemanticFacts,
	defaultPromotionBar,
	getChapterForMonth,
	getRelevantExistingFactsForDedup,
	listSpooledChatIds,
	loadPromotionSpool,
	loadRelationshipMemory,
	meetsPromotionBar,
	type PromotionSource,
	recordPromotionDecision,
	recordSpoolAttempt,
	removeSpooledChunk,
	spoolChunk,
	updateRelationshipMemory,
	upsertChapter,
	withChatLock,
} from "./index.ts";
import {
	MAX_PROMOTION_ATTEMPTS,
	type PreparedPromotion,
	promotionId,
	type SpooledChunk,
	savePreparedPromotion,
} from "./promotion-spool.ts";
import { commitSpooledRemoval } from "./sensory.ts";

export interface PromotionDependencies {
	evaluate: typeof evaluateConversationChunk;
	embed: typeof generateEmbedding;
	narrate: typeof generateLongTermMemoryUpdate;
	saveEpisode: typeof addEpisode;
	saveFacts: typeof addSemanticFacts;
	saveRelationship: typeof updateRelationshipMemory;
	saveChapter: typeof upsertChapter;
	complete: typeof removeSpooledChunk;
}
export const defaultPromotionDependencies: PromotionDependencies = {
	evaluate: evaluateConversationChunk,
	embed: generateEmbedding,
	narrate: generateLongTermMemoryUpdate,
	saveEpisode: addEpisode,
	saveFacts: addSemanticFacts,
	saveRelationship: updateRelationshipMemory,
	saveChapter: upsertChapter,
	complete: removeSpooledChunk,
};

function uniqueNames(names: string[]): string[] {
	return [...new Set(names.filter((name) => name.trim().length > 0))];
}

function formatExistingFactSummary(facts: SemanticFact[]): string | undefined {
	if (facts.length === 0) return undefined;
	return facts
		.map(
			(fact) =>
				`- (${fact.id}) [${fact.subject || fact.category}] ${fact.content}`,
		)
		.join("\n");
}

function inferSemanticScope(
	fact: Pick<SemanticFact, "category" | "subject">,
): SemanticFact["scope"] {
	if (fact.category === "person") return "person";
	if (fact.subject) return "person";
	return "chat";
}

async function updateNarrativeMemory(
	chatId: number,
	id: string,
	prepared: PreparedPromotion,
	dependencies: PromotionDependencies,
): Promise<void> {
	const { episode, recentText } = prepared;
	const month = botNow(episode.timestamp).format("YYYY-MM");
	const [existingRelationship, existingChapter] = await Promise.all([
		loadRelationshipMemory(chatId),
		getChapterForMonth(chatId, month),
	]);
	const relationshipApplied = existingRelationship?.appliedEpisodeIds?.includes(
		episode.id,
	);
	const chapterApplied = existingChapter?.episodeIds.includes(episode.id);
	if (relationshipApplied && chapterApplied) return;
	const fingerprint = (value: unknown) =>
		createHash("sha256")
			.update(JSON.stringify(value ?? null))
			.digest("hex");
	const currentBase = {
		relationship: fingerprint(existingRelationship),
		chapter: fingerprint(existingChapter),
	};
	// Another chunk may have succeeded while this one was awaiting recovery.
	// Rebuild only unapplied narrative effects whose source state has changed.
	if (
		!prepared.narrative ||
		(!relationshipApplied &&
			prepared.narrativeBase?.relationship !== currentBase.relationship) ||
		(!chapterApplied && prepared.narrativeBase?.chapter !== currentBase.chapter)
	) {
		prepared.narrative = await dependencies.narrate({
			existingRelationship,
			existingChapter,
			episode,
			recentMessages: recentText,
			month,
		});
		prepared.narrativeBase = currentBase;
		await savePreparedPromotion(chatId, id, prepared);
	}
	const update = prepared.narrative;
	const now = Date.now();
	const writes = await Promise.allSettled([
		dependencies.saveRelationship(chatId, (existing) =>
			existing?.appliedEpisodeIds?.includes(episode.id)
				? existing
				: {
						chatId,
						...update.relationship,
						updatedAt: now,
						interactionCount: (existing?.interactionCount ?? 0) + 1,
						appliedEpisodeIds: [
							...(existing?.appliedEpisodeIds ?? []),
							episode.id,
						],
					},
		),
		dependencies.saveChapter(chatId, month, (existing) =>
			existing?.episodeIds.includes(episode.id)
				? existing
				: {
						id: existing?.id ?? `chapter_${chatId}_${month}`,
						chatId,
						month,
						...update.chapter,
						participants: uniqueNames([
							...(existing?.participants ?? []),
							...episode.participants,
						]),
						importance: Math.max(
							existing?.importance ?? 1,
							update.chapter.importance,
						),
						episodeIds: [...(existing?.episodeIds ?? []), episode.id],
						updatedAt: now,
					},
		),
	]);
	const failures = writes.filter((write) => write.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"Narrative persistence failed",
		);
}

/**
 * Promote a chunk to memory, spooling it on failure so a transient provider
 * error or rate limit can't permanently lose messages. Previously spooled
 * chunks for the chat are retried first (keeps rough chronological order).
 */
export async function promoteToMemoryReliably(
	chatId: number,
	overflow: ConversationMessage[],
	options?: { minImportance?: number; source?: PromotionSource },
): Promise<void> {
	await spoolChunk({
		chatId,
		messages: overflow,
		reason: "overflow",
		...options,
	});
	await drainPromotionSpool(chatId);
}

const spoolDrainsInProgress = new Set<number>();

/**
 * Retry spooled chunks for a chat. Concurrent drains for the same chat are
 * skipped (not queued): chunk removal is keyed by id, but skipping avoids
 * promoting the same chunk twice before the first removal lands.
 */
export async function drainPromotionSpool(
	chatId: number,
	dependencies = defaultPromotionDependencies,
): Promise<void> {
	if (spoolDrainsInProgress.has(chatId)) return;
	spoolDrainsInProgress.add(chatId);
	try {
		const chunks = await loadPromotionSpool(chatId);
		for (const chunk of chunks) {
			if (chunk.failed) continue;
			try {
				await withChatLock(chatId, () =>
					commitSpooledRemoval(chatId, chunk.messages),
				);
				await promoteToMemory(chatId, chunk.messages, {
					minImportance: chunk.minImportance,
					source: chunk.source,
					retried: chunk.attempts > 0,
					chunk,
					dependencies,
				});
				await dependencies.complete(chatId, chunk.id);
			} catch (err) {
				const attempts = await recordSpoolAttempt(chatId, chunk.id);
				if (attempts >= MAX_PROMOTION_ATTEMPTS) {
					log.error(
						`[spool] Retaining failed chunk ${chunk.id} for chat ${chatId} after ${attempts} attempts:`,
						err,
					);
					await alertOwner(
						"promotion-failed",
						`Promotion ${chunk.id} paused after ${attempts} attempts; its messages remain in the spool for recovery.`,
					);
				} else {
					log.warn(
						`[spool] Retry failed for chunk ${chunk.id} in chat ${chatId} (attempt ${attempts}/${MAX_PROMOTION_ATTEMPTS}):`,
						err,
					);
				}
			}
		}
	} finally {
		spoolDrainsInProgress.delete(chatId);
	}
}

/** Retry every chat's spooled chunks (startup + periodic job). */
export async function retrySpooledPromotions(): Promise<void> {
	for (const chatId of await listSpooledChatIds()) {
		await drainPromotionSpool(chatId);
	}
}

export async function promoteToMemory(
	chatId: number,
	overflow: ConversationMessage[],
	options?: {
		minImportance?: number;
		source?: PromotionSource;
		retried?: boolean;
		chunk?: SpooledChunk;
		dependencies?: PromotionDependencies;
	},
): Promise<void> {
	const dependencies = options?.dependencies ?? defaultPromotionDependencies;
	const id = options?.chunk?.id ?? promotionId(chatId, overflow);
	if (!options?.chunk) {
		await spoolChunk({
			chatId,
			messages: overflow,
			reason: "overflow",
			...options,
		});
		return drainPromotionSpool(chatId);
	}
	if (options.chunk.prepared) {
		return applyPreparedPromotion(
			chatId,
			id,
			options.chunk.prepared,
			dependencies,
		);
	}
	const recentText = overflow
		.map(
			(m) => `${m.role === "user" ? (m.name ?? "User") : "Bot"}: ${m.content}`,
		)
		.join("\n");
	const rawParticipants = [
		...new Set(overflow.map((m) => m.name).filter((n): n is string => !!n)),
	];
	const participants = await Promise.all(
		rawParticipants.map((n) => resolveCanonicalName(n)),
	).then(uniqueNames);

	// Keep the extractor's dedup context bounded so promotion cost does not grow
	// linearly with the whole semantic store.
	const existingFacts = await getRelevantExistingFactsForDedup([
		...participants.map((participant) => ({
			content: participant,
			category: "person" as const,
			subject: participant,
			sourceChatId: chatId,
		})),
		{ content: recentText, category: "group" as const, sourceChatId: chatId },
		{ content: recentText, category: "rule" as const, sourceChatId: chatId },
		{ content: recentText, category: "event" as const, sourceChatId: chatId },
	]);
	const existingFactSummary = formatExistingFactSummary(existingFacts);

	const defaultBar = defaultPromotionBar();
	const minImportance = options?.minImportance ?? defaultBar;
	const source: PromotionSource = options?.source ?? "active";
	const baseMetric = {
		chatId,
		source,
		retried: options?.retried === true,
		bar: minImportance,
		defaultBar,
		messageCount: overflow.length,
	};

	// LLM: evaluate and extract
	let result: PromotionResult;
	try {
		result = await dependencies.evaluate(recentText, existingFactSummary);
	} catch (err) {
		// Record the failed attempt before rethrowing: a rising parse-failure rate
		// on the cheap background model is exactly what the metrics exist to catch.
		await recordPromotionDecision({
			...baseMetric,
			ts: Date.now(),
			model: err instanceof ExtractionParseError ? err.model : "",
			parseOk: !(err instanceof ExtractionParseError),
			importance: 0,
			factImportances: [],
			droppedFacts: 0,
			hasPersonalitySignals: false,
			kept: false,
			summary: "",
		});
		if (err instanceof ExtractionParseError) {
			log.warn(
				`[promote] Extraction from ${err.model} was unparseable for chat ${chatId} — spooling for retry. Raw: ${err.snippet}`,
			);
			await alertOwner(
				"memory-extraction",
				`Background extraction returned unparseable output from ${err.model}. Memory writes for chat ${chatId} are being retried.`,
			);
		}
		throw err;
	}

	log.debug(
		`[promote] Summary: "${result.summary}", importance: ${result.importance}, facts: ${result.facts.length}`,
	);

	// Downstream gate: skip if the LLM judged the chunk uninteresting. The heuristic
	// pre-filter is intentionally loose so transient activity mentions don't get
	// silently dropped — but if even the LLM finds nothing worth keeping, don't
	// pollute episodes with "casual conversation" placeholders. Bars live in
	// promotion-policy.ts and every decision is recorded, so the passive bar can
	// be calibrated against what it actually dropped (`bun run promote:stats`).
	const factImportances = result.facts.map((f) => f.importance);
	const hasSignals = !!result.personalitySignals?.traitChanges?.length;
	const kept = meetsPromotionBar(
		{
			importance: result.importance,
			factImportances,
			hasPersonalitySignals: hasSignals,
		},
		minImportance,
		defaultBar,
	);

	await recordPromotionDecision({
		...baseMetric,
		ts: Date.now(),
		model: result.extraction?.model ?? "",
		parseOk: true,
		importance: result.importance,
		factImportances,
		droppedFacts: result.extraction?.droppedFacts ?? 0,
		hasPersonalitySignals: hasSignals,
		kept,
		summary: result.summary,
	});

	if (!kept) {
		log.debug(`[promote] Skipped: chunk below importance bar ${minImportance}`);
		return;
	}

	// Generate episode embedding.
	const episodeEmbedding = await dependencies.embed(result.summary);

	const now = Math.max(...overflow.map((message) => message.timestamp));
	const episode = {
		id: `ep_${id}`,
		summary: result.summary,
		participants,
		timestamp: now,
		importance: result.importance,
		embedding: episodeEmbedding,
		embeddingModel: getEmbeddingModel(),
		embeddingDim: episodeEmbedding.length,
	};
	let semanticFacts: SemanticFact[] = [];

	// Add semantic facts with embeddings in parallel (canonicalize subjects)
	if (result.facts.length > 0) {
		const factsWithEmbeddings = await Promise.all(
			result.facts.map(async (fact) => {
				const [canonicalSubject, factEmbedding] = await Promise.all([
					fact.subject
						? resolveCanonicalName(fact.subject)
						: Promise.resolve(undefined),
					dependencies.embed(fact.content),
				]);
				return { ...fact, canonicalSubject, factEmbedding };
			}),
		);
		semanticFacts = factsWithEmbeddings.map((fact, index) => ({
			id: `fact_${id}_${index}`,
			content: fact.content,
			category: fact.category,
			subject: fact.canonicalSubject,
			context: fact.context,
			embedding: fact.factEmbedding,
			embeddingModel: getEmbeddingModel(),
			embeddingDim: fact.factEmbedding.length,
			importance: fact.importance,
			confidence: 1.0,
			createdAt: now,
			lastConfirmed: now,
			lastDecayedAt: now,
			scope: inferSemanticScope(fact),
			sourceChatId: chatId,
			supersedes: fact.supersedes,
			...(fact.permanent ? { permanent: true } : {}),
		}));
	}

	const prepared: PreparedPromotion = {
		episode,
		facts: semanticFacts,
		personalitySignals: result.personalitySignals,
		recentText,
	};
	await savePreparedPromotion(chatId, id, prepared);
	await applyPreparedPromotion(chatId, id, prepared, dependencies);
}

async function applyPreparedPromotion(
	chatId: number,
	id: string,
	prepared: PreparedPromotion,
	dependencies: PromotionDependencies,
): Promise<void> {
	await dependencies.saveEpisode(chatId, prepared.episode);
	await dependencies.saveFacts(prepared.facts);
	if (prepared.personalitySignals?.traitChanges.length) {
		await applyPersonalitySignals(
			prepared.personalitySignals,
			prepared.recentText,
			id,
		);
	}
	await updateNarrativeMemory(chatId, id, prepared, dependencies);
}
