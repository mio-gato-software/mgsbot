import { memoryPath } from "../runtime-paths.ts";
import type { RelationshipMemory } from "../types.ts";
import { withRelationshipLock } from "./locks.ts";
import { relationshipSchema } from "./schemas.ts";
import { readStore, writeStore } from "./storage.ts";
import { CURRENT_SCHEMA_VERSION } from "./versioning.ts";

export const RELATIONSHIPS_DIR = memoryPath("relationships");

function relationshipPath(chatId: number): string {
	return `${RELATIONSHIPS_DIR}/${chatId}.json`;
}

export async function loadRelationshipMemory(
	chatId: number,
): Promise<RelationshipMemory | null> {
	return readStore(
		relationshipPath(chatId),
		relationshipSchema.nullable(),
		() => null,
	);
}

export async function saveRelationshipMemory(
	memory: RelationshipMemory,
): Promise<void> {
	await withRelationshipLock(memory.chatId, async () => {
		memory.schemaVersion = CURRENT_SCHEMA_VERSION;
		await writeStore(
			relationshipPath(memory.chatId),
			memory,
			relationshipSchema,
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
		await writeStore(relationshipPath(chatId), updated, relationshipSchema);
	});
}
