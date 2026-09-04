import { generateEmbedding } from "../embeddings.ts";
import {
	findMentionedCanonicalNames,
	resolveCanonicalName,
} from "../identities.ts";
import {
	getFactsForSubjects,
	getPermanentFacts,
	getQueryEmbedding,
	getRecentChapters,
	getRelevantEpisodes,
	getRelevantFacts,
	loadRelationshipMemory,
} from "../memory/index.ts";
import type { ConversationMessage } from "../types.ts";

export interface RetrievalInput {
	chatId: number;
	messages: ConversationMessage[];
	episodeLimit?: number;
	factLimit?: number;
	participantFactLimit?: number;
	nameWindow?: number;
}

/** Shared memory retrieval for user turns and proactive messages. No Telegram side effects. */
export async function retrieveMemoryContext(input: RetrievalInput) {
	const { chatId, messages } = input;
	const [{ embedding, text }, names] = await Promise.all([
		messages.length
			? getQueryEmbedding(messages)
			: generateEmbedding(
					"casual greeting everyday conversation how are you",
				).then((embedding) => ({ embedding, text: "" })),
		Promise.all(
			[
				...new Set(
					messages
						.slice(-(input.nameWindow ?? 6))
						.flatMap((message) => (message.name ? [message.name] : [])),
				),
			].map(resolveCanonicalName),
		),
	]);
	const activeNames = [...new Set(names)];
	const mentionedNames = await findMentionedCanonicalNames(text);
	const subjects = [...new Set([...activeNames, ...mentionedNames])];
	const [
		relevantEpisodes,
		facts,
		participantFacts,
		permanentFacts,
		relationshipMemory,
		recentChapters,
	] = await Promise.all([
		getRelevantEpisodes(chatId, embedding, text, input.episodeLimit ?? 3),
		getRelevantFacts(embedding, {
			queryText: text,
			maxCount: input.factLimit ?? 8,
			chatId,
		}),
		getFactsForSubjects(subjects, input.participantFactLimit ?? 3),
		getPermanentFacts(),
		loadRelationshipMemory(chatId),
		getRecentChapters(chatId),
	]);
	const byId = new Map(facts.map((fact) => [fact.id, fact]));
	for (const fact of participantFacts)
		if (!byId.has(fact.id)) byId.set(fact.id, fact);
	return {
		relevantEpisodes,
		relevantFacts: [...byId.values()],
		permanentFacts,
		relationshipMemory,
		recentChapters,
		activeNames,
		mentionedNames,
	};
}
