import { readFile } from "node:fs/promises";
import { log } from "../logger.ts";
import type { RelationshipMemory } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { withRelationshipLock } from "./locks.ts";
import { CURRENT_SCHEMA_VERSION } from "./versioning.ts";

export const RELATIONSHIPS_DIR = "./memory/relationships";

function relationshipPath(chatId: number): string {
	return `${RELATIONSHIPS_DIR}/${chatId}.json`;
}

export async function loadRelationshipMemory(
	chatId: number,
): Promise<RelationshipMemory | null> {
	try {
		const data = await readFile(relationshipPath(chatId), "utf-8");
		return JSON.parse(data) as RelationshipMemory;
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error(`[memory] Error loading relationship ${chatId}:`, err);
		}
		return null;
	}
}

export async function saveRelationshipMemory(
	memory: RelationshipMemory,
): Promise<void> {
	await withRelationshipLock(memory.chatId, async () => {
		memory.schemaVersion = CURRENT_SCHEMA_VERSION;
		await atomicWriteFile(
			relationshipPath(memory.chatId),
			JSON.stringify(memory, null, 2),
		);
	});
}

/**
 * Read-modify-write under the relationship lock. The updater receives the
 * freshly loaded state so merges (e.g. interactionCount) can't be computed
 * from a stale pre-lock snapshot.
 */
export async function updateRelationshipMemory(
	chatId: number,
	updater: (existing: RelationshipMemory | null) => RelationshipMemory,
): Promise<void> {
	await withRelationshipLock(chatId, async () => {
		const existing = await loadRelationshipMemory(chatId);
		const updated = updater(existing);
		updated.schemaVersion = CURRENT_SCHEMA_VERSION;
		await atomicWriteFile(
			relationshipPath(chatId),
			JSON.stringify(updated, null, 2),
		);
	});
}
