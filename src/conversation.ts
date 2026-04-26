import type { Context } from "grammy";
import { generateResponse } from "./ai/core.ts";
import { evaluateConversationChunk } from "./ai/evaluation.ts";
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
import {
	addEpisode,
	addMessageToSensory,
	addSemanticFacts,
	getFactsForSubjects,
	getPermanentFacts,
	getQueryEmbedding,
	getRelevantEpisodes,
	getRelevantExistingFactsForDedup,
	getRelevantFacts,
	loadSensory,
	withChatLock,
} from "./memory/index.ts";
import { applyPersonalitySignals } from "./personality.ts";
import { assembleSystemPrompt } from "./prompt/assemble.ts";
import { buildPromptContext } from "./prompt/context.ts";
import { buildMessages } from "./prompt/history.ts";
import { isFullAccessActive, isSimpleAssistantMode } from "./prompt/modes.ts";
import type { MediaAttachment } from "./providers/types.ts";
import { sendResponse } from "./response-processor.ts";
import { isTtsAvailable } from "./tts/index.ts";
import type {
	ConversationMessage,
	MentionType,
	SemanticFact,
} from "./types.ts";

const isDev = process.env.NODE_ENV === "development";
const ACTIVE_NAME_WINDOW_MESSAGES = 6;
const MAX_RELEVANT_EPISODES = 3;
const MAX_RELEVANT_FACTS = 8;
const MAX_PARTICIPANT_FACTS_PER_SUBJECT = 3;

function uniqueNames(names: string[]): string[] {
	return [...new Set(names.filter((name) => name.trim().length > 0))];
}

function formatExistingFactSummary(facts: SemanticFact[]): string | undefined {
	if (facts.length === 0) return undefined;
	return facts
		.map((fact) => `- [${fact.subject || fact.category}] ${fact.content}`)
		.join("\n");
}

function inferSemanticScope(
	fact: Pick<SemanticFact, "category" | "subject">,
): SemanticFact["scope"] {
	if (fact.category === "person") return "person";
	if (fact.subject) return "person";
	return "chat";
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
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	if (botOff || (isGroupChat(ctx) && isSleepingHour)) {
		try {
			await ctx.react("😴");
		} catch (error) {
			if (isDev) console.error("[off] Error reacting:", error);
		}
		return;
	}

	// Register identity for this user
	const { userId, username } = getUserInfo(ctx);
	if (userId) {
		await registerIdentity(userId, userName, username);
	}

	// Load sensory buffer and append the user turn atomically per chat.
	const { buffer, overflow, allowPhotoRequest } = await withChatLock(
		chatId,
		async () => {
			const buf = await loadSensory(chatId);
			const allow = buf.allowPhotoRequest === true;
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
	logUserMessage(userName, userContent).catch(console.error);

	// Promote overflow to memory in background
	if (overflow) {
		promoteToMemory(chatId, overflow).catch((err) => {
			console.error(
				`[promote] Failed for chat ${chatId} (user overflow):`,
				err,
			);
		});
	}

	// Follow-up detection and cancellation (DMs only, background)
	if (!isGroupChat(ctx)) {
		checkAndCancelResolvedFollowUps(chatId, userContent).catch(console.error);
		const recentText = buffer.messages
			.filter((m) => m.role === "user")
			.map((m) => m.content)
			.join("\n");
		detectAndStoreFollowUps(chatId, recentText, userContent).catch(
			console.error,
		);
	}

	// Build prompt and messages
	let shouldGenImage = false;
	let promptCtx: Parameters<typeof assembleSystemPrompt>[0];

	if (isSimpleAssistantMode) {
		promptCtx = buildPromptContext({
			relevantEpisodes: [],
			relevantFacts: [],
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

		// Retrieve episodes, semantic facts, participant facts, and permanent facts in parallel
		const [episodes, facts, participantFacts, permanentFacts] =
			await Promise.all([
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

		shouldGenImage = shouldGenerateImageNow(buffer);
		if (isFullAccessActive()) {
			shouldGenImage = true;
		}
		promptCtx = buildPromptContext({
			relevantEpisodes: episodes,
			relevantFacts: mergedFacts,
			permanentFacts,
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

	// Show typing indicator (non-critical, don't crash if it fails)
	await ctx.replyWithChatAction("typing").catch(() => {});

	// Generate response
	const responseText = await generateResponse(systemPrompt, messages);

	// Process and send the response
	const result = await sendResponse({
		ctx,
		responseText,
		shouldGenImage,
		allowPhotoRequest,
		buffer,
		isGroup: isGroupChat(ctx),
		userImagePath,
	});

	// Save bot response to sensory buffer (only if non-silenced and non-empty)
	if (result?.cleanedText.trim()) {
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
		logBotMessage(result.cleanedText).catch(console.error);

		// Promote bot overflow too
		if (botOverflow) {
			promoteToMemory(chatId, botOverflow).catch((err) => {
				console.error(
					`[promote] Failed for chat ${chatId} (bot overflow):`,
					err,
				);
			});
		}
	}
}

export async function promoteToMemory(
	chatId: number,
	overflow: ConversationMessage[],
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

	if (isDev)
		console.log(
			`[promote] Summary: "${result.summary}", importance: ${result.importance}, facts: ${result.facts.length}`,
		);

	// Downstream gate: skip if the LLM judged the chunk uninteresting. The heuristic
	// pre-filter is intentionally loose so transient activity mentions don't get
	// silently dropped — but if even the LLM finds nothing worth keeping, don't
	// pollute episodes with "casual conversation" placeholders.
	const isTrivial =
		result.importance <= 1 &&
		result.facts.length === 0 &&
		!result.personalitySignals?.traitChanges?.length;
	if (isTrivial) {
		if (isDev) console.log("[promote] Skipped: LLM judged chunk trivial");
		return;
	}

	// Generate episode embedding.
	const episodeEmbedding = await generateEmbedding(result.summary);

	const now = Date.now();
	await addEpisode(chatId, {
		id: `ep_${now}_${Math.random().toString(36).slice(2, 8)}`,
		summary: result.summary,
		participants,
		timestamp: now,
		importance: result.importance,
		embedding: episodeEmbedding,
		embeddingModel: EMBEDDING_MODEL,
		embeddingDim: episodeEmbedding.length,
	});

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
			...(fact.permanent ? { permanent: true } : {}),
		}));
		await addSemanticFacts(semanticFacts);
	}

	// Process personality signals
	if (result.personalitySignals?.traitChanges?.length) {
		await applyPersonalitySignals(result.personalitySignals, recentText);
	}
}
