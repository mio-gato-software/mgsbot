import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { CHAPTERS_DIR } from "./chapters.ts";
import { EPISODES_DIR } from "./episodes.ts";
import { RELATIONSHIPS_DIR } from "./relationships.ts";
import { SEMANTIC_PATH } from "./semantic.ts";
import { SENSORY_DIR } from "./sensory.ts";

export {
	getChapterForMonth,
	getRecentChapters,
	loadChapterStore,
	saveChapterStore,
	upsertChapter,
} from "./chapters.ts";
export {
	addEpisode,
	getRelevantEpisodes,
	loadWorkingMemory,
	saveWorkingMemory,
} from "./episodes.ts";
export {
	withChapterLock,
	withChatLock,
	withEpisodeLock,
	withRelationshipLock,
	withSemanticLock,
} from "./locks.ts";
export {
	computeTextScore,
	getQueryEmbedding,
	normalizeName,
} from "./queries.ts";
export {
	loadRelationshipMemory,
	saveRelationshipMemory,
} from "./relationships.ts";
export {
	addSemanticFacts,
	decayConfidence,
	getFactsForSubjects,
	getPermanentFacts,
	getRelevantExistingFactsForDedup,
	getRelevantFacts,
	loadSemanticStore,
	saveSemanticStore,
} from "./semantic.ts";
export {
	addMessageToSensory,
	loadSensory,
	saveSensory,
} from "./sensory.ts";

export async function initMemoryDirs(): Promise<void> {
	if (!existsSync(SENSORY_DIR)) mkdirSync(SENSORY_DIR, { recursive: true });
	if (!existsSync(EPISODES_DIR)) mkdirSync(EPISODES_DIR, { recursive: true });
	if (!existsSync(RELATIONSHIPS_DIR))
		mkdirSync(RELATIONSHIPS_DIR, { recursive: true });
	if (!existsSync(CHAPTERS_DIR)) mkdirSync(CHAPTERS_DIR, { recursive: true });
	// Create semantic.json if it doesn't exist
	if (!existsSync(SEMANTIC_PATH)) {
		await writeFile(SEMANTIC_PATH, "[]");
	}
}
