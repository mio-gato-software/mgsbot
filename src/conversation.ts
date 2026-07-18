import type { Context } from "grammy";
import { generateResponse } from "./ai/core.ts";
import {
	evaluateConversationChunk,
	generateLongTermMemoryUpdate,
} from "./ai/evaluation.ts";
import { botNow } from "./bot-time.ts";
import { startChatAction } from "./chat-actions.ts";
import { logBotMessage, logUserMessage } from "./chat-logger.ts";
import { EMBEDDING_MODEL, generateEmbedding } from "./embeddings.ts";
import {
	checkAndCancelResolvedFollowUps,
	detectAndStoreFollowUps,
} from "./follow-ups.ts";
import {
	findMentionedCanonicalNames,
	registerIdentity,
	resolveCanonicalName,
} from "./identities.ts";
import { shouldGenerateImageNow } from "./image-scheduler.ts";
import { log } from "./logger.ts";
import {
	addEpisode,
	addMessageToSensory,
	addSemanticFacts,
	getChapterForMonth,
	getFactsForSubjects,
	getPermanentFacts,
	getQueryEmbedding,
	getRecentChapters,
	getRelevantEpisodes,
	getRelevantExistingFactsForDedup,
	getRelevantFacts,
	listSpooledChatIds,
	loadPromotionSpool,
	loadRelationshipMemory,
	loadSensory,
	persistInactivityWipe,
	recordSpoolAttempt,
	reinforceRecalledFacts,
	removeSpooledChunk,
	spoolChunk,
	updateRelationshipMemory,
	upsertChapter,
	withChatLock,
} from "./memory/index.ts";
import { applyPersonalitySignals } from "./personality.ts";
import { assembleSystemPrompt } from "./prompt/assemble.ts";
import { buildPromptContext } from "./prompt/context.ts";
import { buildMessages } from "./prompt/history.ts";
import { isFullAccessActive, isSimpleAssistantMode } from "./prompt/modes.ts";
import type { MediaAttachment } from "./providers/types.ts";
import { type SendResponseResult, sendResponse } from "./response-processor.ts";
import { isTtsAvailable } from "./tts/index.ts";
import type {
	ConversationMessage,
	MentionType,
	SemanticFact,
} from "./types.ts";

const ACTIVE_NAME_WINDOW_MESSAGES = 6;
const MAX_RELEVANT_EPISODES = 3;
const MAX_RELEVANT_FACTS = 8;
const MAX_PARTICIPANT_FACTS_PER_SUBJECT = 3;
// Promotion importance bars: chunks from conversations the bot took part in
// use the default; passively witnessed group chatter must clear a higher bar.
const DEFAULT_PROMOTION_MIN_IMPORTANCE = 2;
const PASSIVE_PROMOTION_MIN_IMPORTANCE = 3;
// Failed promotions are spooled and retried; a chunk that keeps failing
// (e.g., content that deterministically trips the provider) is dropped after
// this many attempts so it can't clog the spool forever.
const MAX_SPOOL_ATTEMPTS = 10;

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

async function updateNarrativeMemory(input: {
	chatId: number;
	episode: {
		id: string;
		summary: string;
		participants: string[];
		timestamp: number;
		importance: number;
	};
	recentText: string;
}): Promise<void> {
	const month = botNow(input.episode.timestamp).format("YYYY-MM");
	const [existingRelationship, existingChapter] = await Promise.all([
		loadRelationshipMemory(input.chatId),
		getChapterForMonth(input.chatId, month),
	]);
	const update = await generateLongTermMemoryUpdate({
		existingRelationship,
		existingChapter,
		episode: { ...input.episode, embedding: [] },
		recentMessages: input.recentText,
		month,
	});
	const now = Date.now();

	// The pre-read snapshots above only feed the LLM. All merge arithmetic
	// (interactionCount, participants, episodeIds, importance) runs against the
	// fresh state re-read inside each store's lock, so concurrent promotions
	// can't lose each other's increments/appends.
	await Promise.all([
		updateRelationshipMemory(input.chatId, (existing) => ({
			chatId: input.chatId,
			summary: update.relationship.summary,
			tone: update.relationship.tone,
			notableDynamics: update.relationship.notableDynamics,
			openThreads: update.relationship.openThreads,
			updatedAt: now,
			interactionCount: (existing?.interactionCount ?? 0) + 1,
		})),
		upsertChapter(input.chatId, month, (existing) => ({
			id: existing?.id ?? `chapter_${input.chatId}_${month}`,
			chatId: input.chatId,
			month,
			title: update.chapter.title,
			summary: update.chapter.summary,
			participants: uniqueNames([
				...(existing?.participants ?? []),
				...input.episode.participants,
			]),
			importance: Math.max(
				existing?.importance ?? 1,
				update.chapter.importance,
			),
			episodeIds: [
				...(existing?.episodeIds ?? []).filter((id) => id !== input.episode.id),
				input.episode.id,
			].slice(-30),
			updatedAt: now,
		})),
	]);
}

export function isGroupChat(ctx: Context): boolean {
	const type = ctx.chat?.type;
	return type === "group" || type === "supergroup";
}

export function getUserDisplayName(ctx: Context): string {
	const user = ctx.from;
	if (!user) return "Unknown";
	return user.first_name && user.last_name
		? `${user.first_name} ${user.last_name}`
		: (user.first_name ?? user.username ?? "Unknown");
}

function getUserInfo(ctx: Context): {
	userId: number | undefined;
	username: string | undefined;
} {
	const user = ctx.from;
	if (!user) return { userId: undefined, username: undefined };
	return { userId: user.id, username: user.username };
}

export async function processConversation(
	ctx: Context,
	userContent: string,
	userName: string,
	mentionType: MentionType = "none",
	botOff = false,
	isSleepingHour = false,
	mediaAttachment?: MediaAttachment,
	isVoiceMessage?: boolean,
	userImagePath?: string,
	options?: {
		skipHistoricalContext?: boolean;
		userTurnAlreadyRecorded?: boolean;
		groupAutoReply?: boolean;
		groupContinuation?: boolean;
	},
): Promise<boolean> {
	const chatId = ctx.chat?.id;
	if (!chatId) return false;

	if (botOff || (isGroupChat(ctx) && isSleepingHour)) {
		try {
			await ctx.react("😴");
		} catch (error) {
			log.debug("[off] Error reacting:", error);
		}
		return false;
	}

	// Immediate receipt feedback: show "typing…" from the moment we start
	// working on a reply — retrieval plus generation can take many seconds.
	// sendResponse switches the indicator per modality (photo/voice) via the
	// shared handle, and the finally below always clears it.
	const typing = startChatAction(ctx, "typing");
	let result: SendResponseResult | null;
	try {
		// Register identity for this user
		const { userId, username } = getUserInfo(ctx);
		if (userId) {
			await registerIdentity(userId, userName, username);
		}

		// Load sensory buffer and append the user turn atomically per chat.
		const userTurnAlreadyRecorded = options?.userTurnAlreadyRecorded === true;
		const { buffer, overflow, allowPhotoRequest } = await withChatLock(
			chatId,
			async () => {
				const buf = await loadSensory(chatId);
				const allow = buf.allowPhotoRequest === true;
				if (userTurnAlreadyRecorded) {
					return { buffer: buf, overflow: null, allowPhotoRequest: allow };
				}
				const userMessage: ConversationMessage = {
					role: "user",
					name: userName,
					userId,
					content: userContent,
					timestamp: Date.now(),
				};
				const ov = await addMessageToSensory(buf, userMessage);
				return { buffer: buf, overflow: ov, allowPhotoRequest: allow };
			},
		);
		if (!userTurnAlreadyRecorded) {
			logUserMessage(userName, userContent).catch(log.error);
		}

		// Promote overflow to memory in background (spooled for retry on failure)
		if (overflow) {
			promoteToMemoryReliably(chatId, overflow).catch((err) => {
				log.error(`[promote] Failed for chat ${chatId} (user overflow):`, err);
			});
		}

		// Follow-up detection and cancellation (DMs only, background)
		if (!isGroupChat(ctx)) {
			checkAndCancelResolvedFollowUps(chatId, userContent).catch(log.error);
			const recentText = buffer.messages
				.filter((m) => m.role === "user")
				.map((m) => m.content)
				.join("\n");
			detectAndStoreFollowUps(chatId, recentText, userContent).catch(log.error);
		}

		// Build prompt and messages
		let shouldGenImage = false;
		let promptCtx: Parameters<typeof assembleSystemPrompt>[0];
		const skipHistoricalContext = options?.skipHistoricalContext === true;
		if (!isSimpleAssistantMode) {
			shouldGenImage = shouldGenerateImageNow(buffer);
			if (isFullAccessActive()) {
				shouldGenImage = true;
			}
		}

		if (isSimpleAssistantMode || skipHistoricalContext) {
			promptCtx = buildPromptContext({
				relevantEpisodes: [],
				relevantFacts: [],
				mentionType: isGroupChat(ctx) ? mentionType : undefined,
				groupAutoReply: options?.groupAutoReply === true,
				groupContinuation: options?.groupContinuation === true,
				isVoiceMessage,
				userAttachedImage: !!userImagePath,
				shouldGenerateImage: shouldGenImage,
				allowPhotoRequest,
				ttsAvailable: isTtsAvailable(),
			});
		} else {
			// Start query embedding and name resolution in parallel
			const queryEmbeddingPromise = getQueryEmbedding(buffer.messages);
			const rawActiveNames = [
				...new Set(
					buffer.messages
						.slice(-ACTIVE_NAME_WINDOW_MESSAGES)
						.map((m) => m.name)
						.filter((n): n is string => !!n),
				),
			];
			const activeNamesPromise = Promise.all(
				rawActiveNames.map((n) => resolveCanonicalName(n)),
			).then((names) => [...new Set(names)]);

			// Wait for both to complete
			const [{ embedding: queryEmbedding, text: queryText }, activeNames] =
				await Promise.all([queryEmbeddingPromise, activeNamesPromise]);
			const mentionedNames = await findMentionedCanonicalNames(queryText);
			const subjectNames = uniqueNames([...activeNames, ...mentionedNames]);

			// Retrieve episodic, semantic, relationship, chapter, and permanent context in parallel.
			const [
				episodes,
				facts,
				participantFacts,
				permanentFacts,
				relationshipMemory,
				recentChapters,
			] = await Promise.all([
				getRelevantEpisodes(
					chatId,
					queryEmbedding,
					queryText,
					MAX_RELEVANT_EPISODES,
				),
				getRelevantFacts(queryEmbedding, {
					queryText,
					maxCount: MAX_RELEVANT_FACTS,
					chatId,
				}),
				subjectNames.length > 0
					? getFactsForSubjects(subjectNames, MAX_PARTICIPANT_FACTS_PER_SUBJECT)
					: ([] as SemanticFact[]),
				getPermanentFacts(),
				loadRelationshipMemory(chatId),
				getRecentChapters(chatId),
			]);

			// Merge and deduplicate facts
			const allFactIds = new Set(facts.map((f) => f.id));
			const mergedFacts = [...facts];
			for (const pf of participantFacts) {
				if (!allFactIds.has(pf.id)) {
					mergedFacts.push(pf);
					allFactIds.add(pf.id);
				}
			}

			// Retrieval reinforces: facts injected into the prompt get their decay
			// clock reset (throttled), so often-recalled memories don't fade.
			if (mergedFacts.length > 0) {
				reinforceRecalledFacts(mergedFacts.map((f) => f.id)).catch((err) => {
					log.debug("[semantic] Retrieval reinforcement failed:", err);
				});
			}

			promptCtx = buildPromptContext({
				relevantEpisodes: episodes,
				relevantFacts: mergedFacts,
				permanentFacts,
				relationshipMemory,
				recentChapters,
				activeNames,
				mentionedNames,
				mentionType: isGroupChat(ctx) ? mentionType : undefined,
				isVoiceMessage,
				userAttachedImage: !!userImagePath,
				shouldGenerateImage: shouldGenImage,
				allowPhotoRequest,
				ttsAvailable: isTtsAvailable(),
			});
		}

		const systemPrompt = await assembleSystemPrompt(promptCtx);
		const messages = buildMessages(buffer, mediaAttachment);

		// Generate response
		const responseText = await generateResponse(systemPrompt, messages);

		// Process and send the response
		result = await sendResponse({
			ctx,
			responseText,
			shouldGenImage,
			allowPhotoRequest,
			buffer,
			isGroup: isGroupChat(ctx),
			userImagePath,
			chatAction: typing,
		});
	} finally {
		typing.stop();
	}

	// Save bot response to sensory buffer (only if non-silenced and non-empty)
	const didRespond = !!result?.cleanedText.trim();
	if (result && didRespond) {
		const botMessage: ConversationMessage = {
			role: "model",
			content: result.cleanedText,
			timestamp: Date.now(),
		};
		// Serialize per chat: a concurrent user turn arriving right now must not
		// race with this append. Reload the buffer under the lock so we don't
		// clobber its state with the stale in-memory copy.
		const botOverflow = await withChatLock(chatId, async () => {
			const fresh = await loadSensory(chatId);
			return addMessageToSensory(fresh, botMessage);
		});
		logBotMessage(result.cleanedText).catch(log.error);

		// Promote bot overflow too (spooled for retry on failure)
		if (botOverflow) {
			promoteToMemoryReliably(chatId, botOverflow).catch((err) => {
				log.error(`[promote] Failed for chat ${chatId} (bot overflow):`, err);
			});
		}
	}

	return didRespond;
}

export async function observeConversationTurn(
	ctx: Context,
	userContent: string,
	userName: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const { userId, username } = getUserInfo(ctx);
	if (userId) {
		await registerIdentity(userId, userName, username);
	}

	const overflow = await withChatLock(chatId, async () => {
		const buffer = await loadSensory(chatId);
		const userMessage: ConversationMessage = {
			role: "user",
			name: userName,
			userId,
			content: userContent,
			timestamp: Date.now(),
		};
		return addMessageToSensory(buffer, userMessage);
	});
	logUserMessage(userName, userContent).catch(log.error);

	// Passively witnessed messages (the bot wasn't addressed) still get a shot
	// at long-term memory, but only above a higher importance bar so ambient
	// group noise doesn't accumulate.
	if (overflow) {
		promoteToMemoryReliably(chatId, overflow, {
			minImportance: PASSIVE_PROMOTION_MIN_IMPORTANCE,
		}).catch((err) => {
			log.error(
				`[promote] Failed for chat ${chatId} (observer overflow):`,
				err,
			);
		});
	}
}

/**
 * Promote a chunk to memory, spooling it on failure so a transient provider
 * error or rate limit can't permanently lose messages. Previously spooled
 * chunks for the chat are retried first (keeps rough chronological order).
 */
export async function promoteToMemoryReliably(
	chatId: number,
	overflow: ConversationMessage[],
	options?: { minImportance?: number },
): Promise<void> {
	await drainPromotionSpool(chatId);
	try {
		await promoteToMemory(chatId, overflow, options);
	} catch (err) {
		log.error(
			`[promote] Failed for chat ${chatId} — spooling chunk for retry:`,
			err,
		);
		await spoolChunk({
			chatId,
			messages: overflow,
			reason: "promotion-failed",
			minImportance: options?.minImportance,
		});
	}
}

const spoolDrainsInProgress = new Set<number>();

/**
 * Retry spooled chunks for a chat. Concurrent drains for the same chat are
 * skipped (not queued): chunk removal is keyed by id, but skipping avoids
 * promoting the same chunk twice before the first removal lands.
 */
export async function drainPromotionSpool(chatId: number): Promise<void> {
	if (spoolDrainsInProgress.has(chatId)) return;
	spoolDrainsInProgress.add(chatId);
	try {
		const chunks = await loadPromotionSpool(chatId);
		for (const chunk of chunks) {
			try {
				if (chunk.reason === "inactivity-wipe") {
					// Commit the wipe to disk before promoting: a still-stale buffer
					// would otherwise re-spool this chunk after removal and promote
					// the same messages twice.
					await withChatLock(chatId, () => persistInactivityWipe(chatId));
				}
				await promoteToMemory(chatId, chunk.messages, {
					minImportance: chunk.minImportance,
				});
				await removeSpooledChunk(chatId, chunk.id);
			} catch (err) {
				const attempts = await recordSpoolAttempt(chatId, chunk.id);
				if (attempts >= MAX_SPOOL_ATTEMPTS) {
					log.error(
						`[spool] Giving up on chunk ${chunk.id} for chat ${chatId} after ${attempts} attempts:`,
						err,
					);
					await removeSpooledChunk(chatId, chunk.id);
				} else {
					log.warn(
						`[spool] Retry failed for chunk ${chunk.id} in chat ${chatId} (attempt ${attempts}/${MAX_SPOOL_ATTEMPTS}):`,
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
	options?: { minImportance?: number },
): Promise<void> {
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

	// LLM: evaluate and extract
	const result = await evaluateConversationChunk(
		recentText,
		existingFactSummary,
	);

	log.debug(
		`[promote] Summary: "${result.summary}", importance: ${result.importance}, facts: ${result.facts.length}`,
	);

	// Downstream gate: skip if the LLM judged the chunk uninteresting. The heuristic
	// pre-filter is intentionally loose so transient activity mentions don't get
	// silently dropped — but if even the LLM finds nothing worth keeping, don't
	// pollute episodes with "casual conversation" placeholders. At the default
	// bar any fact or personality signal rescues the chunk; above it (passive
	// group chatter) the episode or a fact must itself clear the bar.
	const minImportance =
		options?.minImportance ?? DEFAULT_PROMOTION_MIN_IMPORTANCE;
	const aboveDefaultBar = minImportance > DEFAULT_PROMOTION_MIN_IMPORTANCE;
	const hasQualifyingFacts = aboveDefaultBar
		? result.facts.some((f) => f.importance >= minImportance)
		: result.facts.length > 0;
	const hasSignals = !!result.personalitySignals?.traitChanges?.length;
	const meetsBar =
		result.importance >= minImportance ||
		hasQualifyingFacts ||
		(!aboveDefaultBar && hasSignals);
	if (!meetsBar) {
		log.debug(`[promote] Skipped: chunk below importance bar ${minImportance}`);
		return;
	}

	// Generate episode embedding.
	const episodeEmbedding = await generateEmbedding(result.summary);

	const now = Date.now();
	const episode = {
		id: `ep_${now}_${Math.random().toString(36).slice(2, 8)}`,
		summary: result.summary,
		participants,
		timestamp: now,
		importance: result.importance,
		embedding: episodeEmbedding,
		embeddingModel: EMBEDDING_MODEL,
		embeddingDim: episodeEmbedding.length,
	};
	await addEpisode(chatId, episode);

	// Add semantic facts with embeddings in parallel (canonicalize subjects)
	if (result.facts.length > 0) {
		const factsWithEmbeddings = await Promise.all(
			result.facts.map(async (fact) => {
				const [canonicalSubject, factEmbedding] = await Promise.all([
					fact.subject
						? resolveCanonicalName(fact.subject)
						: Promise.resolve(undefined),
					generateEmbedding(fact.content),
				]);
				return { ...fact, canonicalSubject, factEmbedding };
			}),
		);
		const semanticFacts: SemanticFact[] = factsWithEmbeddings.map((fact) => ({
			id: `fact_${now}_${Math.random().toString(36).slice(2, 8)}`,
			content: fact.content,
			category: fact.category,
			subject: fact.canonicalSubject,
			context: fact.context,
			embedding: fact.factEmbedding,
			embeddingModel: EMBEDDING_MODEL,
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
		await addSemanticFacts(semanticFacts);
	}

	// Process personality signals
	if (result.personalitySignals?.traitChanges?.length) {
		await applyPersonalitySignals(result.personalitySignals, recentText);
	}

	updateNarrativeMemory({ chatId, episode, recentText }).catch((err) => {
		log.error(`[long-term-memory] Failed for chat ${chatId}:`, err);
	});
}
