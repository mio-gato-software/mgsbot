import { readFile } from "node:fs/promises";
import type { RelationshipMemory } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { withRelationshipLock } from "./locks.ts";

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
			console.error(`[memory] Error loading relationship ${chatId}:`, err);
		}
		return null;
	}
}

export async function saveRelationshipMemory(
	memory: RelationshipMemory,
): Promise<void> {
	await withRelationshipLock(memory.chatId, async () => {
		await atomicWriteFile(
			relationshipPath(memory.chatId),
			JSON.stringify(memory, null, 2),
		);
	});
}
