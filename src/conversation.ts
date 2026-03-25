import type { Context } from "grammy";
import { evaluateConversationChunk, generateResponse } from "./ai.ts";
import { logBotMessage, logUserMessage } from "./chat-logger.ts";
import { generateEmbedding } from "./embeddings.ts";
import {
	checkAndCancelResolvedFollowUps,
	detectAndStoreFollowUps,
} from "./follow-ups.ts";
import { registerIdentity, resolveCanonicalName } from "./identities.ts";
import { shouldGenerateImageNow } from "./image-scheduler.ts";
import {
	addEpisode,
	addMessageToSensory,
	addSemanticFacts,
	getFactsForSubjects,
	getQueryEmbedding,
	getRelevantEpisodes,
	getRelevantFacts,
	hasSignificantContent,
	loadSemanticStore,
	loadSensory,
} from "./memory.ts";
import { applyPersonalitySignals } from "./personality.ts";
import {
	buildMessages,
	buildSystemPrompt,
	isSimpleAssistantMode,
} from "./prompt.ts";
import type { MediaAttachment } from "./providers/types.ts";
import { sendResponse } from "./response-processor.ts";
import { isTtsAvailable } from "./tts.ts";
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

	// Load sensory buffer
	const buffer = await loadSensory(chatId);
	const allowPhotoRequest = buffer.allowPhotoRequest === true;
	const userMessage: ConversationMessage = {
		role: "user",
		name: userName,
		userId,
		content: userContent,
		timestamp: Date.now(),
	};
	const overflow = await addMessageToSensory(buffer, userMessage);
	logUserMessage(userName, userContent).catch(console.error);

	// Promote overflow to memory in background
	if (overflow) {
		promoteToMemory(chatId, overflow).catch(console.error);
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
	let systemPrompt: string;
	let shouldGenImage = false;

	if (isSimpleAssistantMode) {
		systemPrompt = await buildSystemPrompt([], [], false);
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

		// Retrieve episodes, semantic facts, and participant facts in parallel
		const [episodes, facts, participantFacts] = await Promise.all([
			getRelevantEpisodes(
				chatId,
				queryEmbedding,
				queryText,
				MAX_RELEVANT_EPISODES,
			),
			getRelevantFacts(queryEmbedding, {
				queryText,
				maxCount: MAX_RELEVANT_FACTS,
			}),
			activeNames.length > 0
				? getFactsForSubjects(activeNames, MAX_PARTICIPANT_FACTS_PER_SUBJECT)
				: ([] as SemanticFact[]),
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
		systemPrompt = await buildSystemPrompt(
			episodes,
			mergedFacts,
			shouldGenImage,
			isGroupChat(ctx) ? mentionType : undefined,
			activeNames,
			allowPhotoRequest,
			isVoiceMessage === true,
			isTtsAvailable(),
		);
	}
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
	});

	// Save bot response to sensory buffer (only if non-silenced and non-empty)
	if (result?.cleanedText.trim()) {
		const botMessage: ConversationMessage = {
			role: "model",
			content: result.cleanedText,
			timestamp: Date.now(),
		};
		const botOverflow = await addMessageToSensory(buffer, botMessage);
		logBotMessage(result.cleanedText).catch(console.error);

		// Promote bot overflow too
		if (botOverflow) {
			promoteToMemory(chatId, botOverflow).catch(console.error);
		}
	}
}

export async function promoteToMemory(
	chatId: number,
	overflow: ConversationMessage[],
): Promise<void> {
	// Heuristic pre-filter: skip trivial conversation
	if (!hasSignificantContent(overflow)) {
		if (isDev) console.log("[promote] Skipped: no significant content");
		return;
	}

	const recentText = overflow
		.map(
			(m) => `${m.role === "user" ? (m.name ?? "User") : "Bot"}: ${m.content}`,
		)
		.join("\n");

	// Build existing fact summary for dedup (include all facts, grouped by subject/category)
	const store = await loadSemanticStore();
	const existingFactSummary =
		store.length > 0
			? store
					.map((f) => `- [${f.subject || f.category}] ${f.content}`)
					.join("\n")
			: undefined;

	// LLM: evaluate and extract
	const result = await evaluateConversationChunk(
		recentText,
		existingFactSummary,
	);

	if (isDev)
		console.log(
			`[promote] Summary: "${result.summary}", importance: ${result.importance}, facts: ${result.facts.length}`,
		);

	// Generate episode embedding, resolve participants, and fact embeddings in parallel
	const rawParticipants = [
		...new Set(overflow.map((m) => m.name).filter((n): n is string => !!n)),
	];
	const [episodeEmbedding, participants] = await Promise.all([
		generateEmbedding(result.summary),
		Promise.all(rawParticipants.map((n) => resolveCanonicalName(n))).then(
			(names) => [...new Set(names)],
		),
	]);

	const now = Date.now();
	await addEpisode(chatId, {
		id: `ep_${now}_${Math.random().toString(36).slice(2, 8)}`,
		summary: result.summary,
		participants,
		timestamp: now,
		importance: result.importance,
		embedding: episodeEmbedding,
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
			importance: fact.importance,
			confidence: 1.0,
			createdAt: now,
			lastConfirmed: now,
		}));
		await addSemanticFacts(semanticFacts);
	}

	// Process personality signals
	if (result.personalitySignals?.traitChanges?.length) {
		await applyPersonalitySignals(result.personalitySignals, recentText);
	}
}
