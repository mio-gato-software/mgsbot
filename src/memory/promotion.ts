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
import { confirmSemanticFacts } from "./semantic.ts";
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

const NARRATIVE_BATCH_SIZE = 4;
const NARRATIVE_MAX_WAIT_MS = 60 * 60 * 1000;

async function updateNarrativeMemory(
	chatId: number,
	chunks: SpooledChunk[],
	dependencies: PromotionDependencies,
): Promise<void> {
	const first = chunks[0];
	if (!first?.prepared) return;
	const prepared = first.prepared;
	const promotions = chunks.flatMap((chunk) =>
		chunk.prepared ? [chunk.prepared] : [],
	);
	const episodes = promotions.map((item) => item.episode);
	const episodeIds = episodes.map((episode) => episode.id);
	const month = botNow(prepared.episode.timestamp).format("YYYY-MM");
	const [existingRelationship, existingChapter] = await Promise.all([
		loadRelationshipMemory(chatId),
		getChapterForMonth(chatId, month),
	]);
	const relationshipApplied = episodeIds.every((id) =>
		existingRelationship?.appliedEpisodeIds?.includes(id),
	);
	const chapterApplied = episodeIds.every((id) =>
		existingChapter?.episodeIds.includes(id),
	);
	if (relationshipApplied && chapterApplied) return;
	const fingerprint = (value: unknown) =>
		createHash("sha256")
			.update(JSON.stringify(value ?? null))
			.digest("hex");
	const currentBase = {
		relationship: fingerprint(existingRelationship),
		chapter: fingerprint(existingChapter),
	};
	const previousIds = prepared.narrativeEpisodeIds ?? [prepared.episode.id];
	if (
		!prepared.narrative ||
		fingerprint(previousIds) !== fingerprint(episodeIds) ||
		(!relationshipApplied &&
			prepared.narrativeBase?.relationship !== currentBase.relationship) ||
		(!chapterApplied && prepared.narrativeBase?.chapter !== currentBase.chapter)
	) {
		prepared.narrative = await dependencies.narrate({
			existingRelationship,
			existingChapter,
			month,
			episode: {
				...prepared.episode,
				summary: episodes
					.map(
						(episode) =>
							`[${botNow(episode.timestamp).format("YYYY-MM-DD")}] ${episode.summary}`,
					)
					.join("\n"),
				participants: uniqueNames(
					episodes.flatMap((episode) => episode.participants),
				),
				importance: Math.max(...episodes.map((episode) => episode.importance)),
			},
			// Extraction has already captured the durable details. Do not pay to send
			// full transcripts again for every narrative rewrite.
			recentMessages: promotions
				.map((item) =>
					[
						item.episode.summary,
						...item.facts.map((fact) => fact.content),
						...(item.personalitySignals?.traitChanges.map(
							(change) => change.reason,
						) ?? []),
					].join("\n"),
				)
				.join("\n\n"),
		});
		prepared.narrativeBase = currentBase;
		prepared.narrativeEpisodeIds = episodeIds;
		await savePreparedPromotion(chatId, first.id, prepared);
	}
	const update = prepared.narrative;
	const writes = await Promise.allSettled([
		dependencies.saveRelationship(chatId, (existing) => {
			const unapplied = episodeIds.filter(
				(id) => !existing?.appliedEpisodeIds?.includes(id),
			);
			if (!unapplied.length && existing) return existing;
			return {
				chatId,
				...update.relationship,
				updatedAt: Date.now(),
				interactionCount: (existing?.interactionCount ?? 0) + unapplied.length,
				appliedEpisodeIds: [
					...(existing?.appliedEpisodeIds ?? []),
					...unapplied,
				],
			};
		}),
		dependencies.saveChapter(chatId, month, (existing) => {
			const unapplied = episodeIds.filter(
				(id) => !existing?.episodeIds.includes(id),
			);
			if (!unapplied.length && existing) return existing;
			return {
				id: existing?.id ?? `chapter_${chatId}_${month}`,
				chatId,
				month,
				...update.chapter,
				participants: uniqueNames([
					...(existing?.participants ?? []),
					...episodes.flatMap((episode) => episode.participants),
				]),
				importance: Math.max(
					existing?.importance ?? 1,
					update.chapter.importance,
				),
				episodeIds: [...(existing?.episodeIds ?? []), ...unapplied],
				updatedAt: Date.now(),
			};
		}),
	]);
	const failures = writes.filter((write) => write.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"Narrative persistence failed",
		);
}

async function recordFailure(
	chatId: number,
	chunk: SpooledChunk,
	error: unknown,
): Promise<void> {
	const attempts = await recordSpoolAttempt(chatId, chunk.id);
	log.warn(
		`[spool] Failed chunk ${chunk.id} (attempt ${attempts}/${MAX_PROMOTION_ATTEMPTS}):`,
		error,
	);
	if (attempts >= MAX_PROMOTION_ATTEMPTS)
		await alertOwner(
			"promotion-failed",
			`Promotion ${chunk.id} paused after ${attempts} attempts; its messages remain in the spool for recovery.`,
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
	options: { flushNarrative?: boolean } = {},
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
				const pending = (await loadPromotionSpool(chatId)).find(
					(item) => item.id === chunk.id,
				);
				if (!pending?.prepared) await dependencies.complete(chatId, chunk.id);
			} catch (err) {
				await recordFailure(chatId, chunk, err);
			}
		}
		const pending = (await loadPromotionSpool(chatId)).filter(
			(chunk) => !chunk.failed && chunk.prepared?.effectsApplied,
		);
		const months = new Map<string, SpooledChunk[]>();
		for (const chunk of pending) {
			if (!chunk.prepared) continue;
			const month = botNow(chunk.prepared.episode.timestamp).format("YYYY-MM");
			const group = months.get(month) ?? [];
			group.push(chunk);
			months.set(month, group);
		}
		for (const group of months.values()) {
			for (let i = 0; i < group.length; i += NARRATIVE_BATCH_SIZE) {
				const batch = group.slice(i, i + NARRATIVE_BATCH_SIZE);
				const due =
					options.flushNarrative ||
					batch.length >= NARRATIVE_BATCH_SIZE ||
					batch.some(
						(chunk) =>
							chunk.reason === "inactivity-wipe" ||
							Date.now() - chunk.spooledAt >= NARRATIVE_MAX_WAIT_MS ||
							(chunk.prepared?.episode.importance ?? 0) >= 4 ||
							!!chunk.prepared?.narrative,
					);
				if (!due) continue;
				try {
					await updateNarrativeMemory(chatId, batch, dependencies);
					for (const chunk of batch)
						await dependencies.complete(chatId, chunk.id);
				} catch (error) {
					for (const chunk of batch) await recordFailure(chatId, chunk, error);
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
		await drainPromotionSpool(chatId, defaultPromotionDependencies, {
			flushNarrative: true,
		});
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
			content: `${participant} ${recentText}`,
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
	const confirmedFactIds = [
		...new Set(
			(result.confirmedFacts ?? [])
				.filter(
					(confirmation) =>
						existingFacts.some((fact) => fact.id === confirmation.id) &&
						confirmation.evidence.trim().length >= 8 &&
						overflow.some(
							(message) =>
								message.role === "user" &&
								message.content.includes(confirmation.evidence),
						),
				)
				.map((confirmation) => confirmation.id),
		),
	];
	const factImportances = result.facts.map((f) => f.importance);
	const confirmationImportances = existingFacts
		.filter((fact) => confirmedFactIds.includes(fact.id))
		.map((fact) => fact.importance);
	const hasSignals = !!result.personalitySignals?.traitChanges?.length;
	const kept = meetsPromotionBar(
		{
			importance: result.importance,
			factImportances,
			confirmationImportances,
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
		confirmationImportances,
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
		confirmedFactIds,
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
	if (prepared.effectsApplied) return;
	await dependencies.saveEpisode(chatId, prepared.episode);
	await dependencies.saveFacts(prepared.facts);
	await confirmSemanticFacts(
		prepared.confirmedFactIds ?? [],
		id,
		prepared.episode.timestamp,
	);
	if (prepared.personalitySignals?.traitChanges.length) {
		await applyPersonalitySignals(
			prepared.personalitySignals,
			prepared.recentText,
			id,
		);
	}
	prepared.effectsApplied = true;
	await savePreparedPromotion(chatId, id, prepared);
}
