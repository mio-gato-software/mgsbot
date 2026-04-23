import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { EPISODES_DIR } from "./episodes.ts";
import { SEMANTIC_PATH } from "./semantic.ts";
import { SENSORY_DIR } from "./sensory.ts";

export {
	addEpisode,
	getRelevantEpisodes,
	loadWorkingMemory,
	saveWorkingMemory,
} from "./episodes.ts";
export { withChatLock } from "./locks.ts";
export {
	computeTextScore,
	getQueryEmbedding,
	hasSignificantContent,
	normalizeName,
} from "./queries.ts";
export {
	addSemanticFacts,
	decayConfidence,
	getFactsForSubjects,
	getPermanentFacts,
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
	// Create semantic.json if it doesn't exist
	if (!existsSync(SEMANTIC_PATH)) {
		await writeFile(SEMANTIC_PATH, "[]");
	}
}
