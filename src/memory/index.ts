import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { CHAPTERS_DIR } from "./chapters.ts";
import { EPISODES_DIR } from "./episodes.ts";
import { RELATIONSHIPS_DIR } from "./relationships.ts";
import { SEMANTIC_PATH } from "./semantic.ts";
import { SENSORY_DIR } from "./sensory.ts";
import { wrapVersioned } from "./versioning.ts";

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
	withCheckInsLock,
	withEpisodeLock,
	withFollowUpsLock,
	withPersonalityLock,
	withPromotionSpoolLock,
	withRelationshipLock,
	withSemanticLock,
} from "./locks.ts";
export {
	listSpooledChatIds,
	loadPromotionSpool,
	recordSpoolAttempt,
	removeSpooledChunk,
	spoolChunk,
} from "./promotion-spool.ts";
export {
	computeTextScore,
	getQueryEmbedding,
	normalizeName,
} from "./queries.ts";
export {
	loadRelationshipMemory,
	saveRelationshipMemory,
	updateRelationshipMemory,
} from "./relationships.ts";
export {
	addSemanticFacts,
	decayConfidence,
	getFactsForSubjects,
	getPermanentFacts,
	getRelevantExistingFactsForDedup,
	getRelevantFacts,
	isFactActive,
	loadSemanticStore,
	reinforceRecalledFacts,
	saveSemanticStore,
} from "./semantic.ts";
export {
	addMessageToSensory,
	loadSensory,
	persistInactivityWipe,
	saveSensory,
} from "./sensory.ts";
export {
	CURRENT_SCHEMA_VERSION,
	unwrapVersioned,
	wrapVersioned,
} from "./versioning.ts";

export async function initMemoryDirs(): Promise<void> {
	if (!existsSync(SENSORY_DIR)) mkdirSync(SENSORY_DIR, { recursive: true });
	if (!existsSync(EPISODES_DIR)) mkdirSync(EPISODES_DIR, { recursive: true });
	if (!existsSync(RELATIONSHIPS_DIR))
		mkdirSync(RELATIONSHIPS_DIR, { recursive: true });
	if (!existsSync(CHAPTERS_DIR)) mkdirSync(CHAPTERS_DIR, { recursive: true });
	// Create semantic.json if it doesn't exist
	if (!existsSync(SEMANTIC_PATH)) {
		await writeFile(SEMANTIC_PATH, JSON.stringify(wrapVersioned([]), null, 2));
	}
}
