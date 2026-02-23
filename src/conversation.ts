import type { Context } from "grammy";
import { evaluateConversationChunk, generateResponse } from "./ai.ts";
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
import {
	applyPersonalitySignals,
	regenerateDescription,
} from "./personality.ts";
import {
	buildMessages,
	buildSystemPrompt,
	isSimpleAssistantMode,
} from "./prompt.ts";
import { sendResponse } from "./response-processor.ts";
import type {
	ConversationMessage,
	MentionType,
	SemanticFact,
} from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

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
		// Generate query embedding for retrieval
		const { embedding: queryEmbedding, text: queryText } =
			await getQueryEmbedding(buffer.messages);

		// Retrieve relevant episodes and facts
		const [episodes, facts] = await Promise.all([
			getRelevantEpisodes(chatId, queryEmbedding, queryText),
			getRelevantFacts(queryEmbedding, { queryText }),
		]);

		// Also get facts for active participants (canonicalized)
		const rawActiveNames = [
			...new Set(
				buffer.messages.map((m) => m.name).filter((n): n is string => !!n),
			),
		];
		const activeNames = await Promise.all(
			rawActiveNames.map((n) => resolveCanonicalName(n)),
		).then((names) => [...new Set(names)]);
		const participantFacts =
			activeNames.length > 0 ? await getFactsForSubjects(activeNames) : [];

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
		);
	}
	const messages = buildMessages(buffer);

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

	// Create episode with embedding
	const episodeEmbedding = await generateEmbedding(result.summary);
	const rawParticipants = [
		...new Set(overflow.map((m) => m.name).filter((n): n is string => !!n)),
	];
	const participants = await Promise.all(
		rawParticipants.map((n) => resolveCanonicalName(n)),
	).then((names) => [...new Set(names)]);

	const now = Date.now();
	await addEpisode(chatId, {
		id: `ep_${now}_${Math.random().toString(36).slice(2, 8)}`,
		summary: result.summary,
		participants,
		timestamp: now,
		importance: result.importance,
		embedding: episodeEmbedding,
	});

	// Add semantic facts with embeddings (canonicalize subjects)
	if (result.facts.length > 0) {
		const semanticFacts: SemanticFact[] = [];
		for (const fact of result.facts) {
			const canonicalSubject = fact.subject
				? await resolveCanonicalName(fact.subject)
				: undefined;
			const factEmbedding = await generateEmbedding(fact.content);
			semanticFacts.push({
				id: `fact_${now}_${Math.random().toString(36).slice(2, 8)}`,
				content: fact.content,
				category: fact.category,
				subject: canonicalSubject,
				context: fact.context,
				embedding: factEmbedding,
				importance: fact.importance,
				confidence: 1.0,
				createdAt: now,
				lastConfirmed: now,
			});
		}
		await addSemanticFacts(semanticFacts);
	}

	// Process personality signals
	if (result.personalitySignals?.traitChanges?.length) {
		const shouldRegenerate = await applyPersonalitySignals(
			result.personalitySignals,
			recentText,
		);
		if (shouldRegenerate) {
			regenerateDescription().catch(console.error);
		}
	}
}
