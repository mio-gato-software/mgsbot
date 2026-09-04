import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { memoryPath } from "../runtime-paths.ts";
import type { ConversationMessage, SensoryBuffer } from "../types.ts";
import { isFileNotFound } from "../utils.ts";
import type { PromotionSource } from "./promotion-metrics.ts";
import { defaultPromotionBar } from "./promotion-policy.ts";
import { messageIdentity, spoolChunk } from "./promotion-spool.ts";
import { sensorySchema } from "./schemas.ts";
import { readStore, writeStore } from "./storage.ts";
import { CURRENT_SCHEMA_VERSION, unwrapVersioned } from "./versioning.ts";

export const SENSORY_DIR = memoryPath("sensory");

const SENSORY_MAX_MESSAGES = 10;
const SENSORY_OVERFLOW_COUNT = 5; // Default messages returned on overflow
const OVERFLOW_MIN_SPLIT = 3; // Boundary-aware overflow: smallest chunk
const OVERFLOW_MAX_SPLIT = 7; // Boundary-aware overflow: largest chunk
const OVERFLOW_BOUNDARY_GAP_MS = 30 * 60 * 1000; // Gap that marks a topic boundary
const INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MEDIA_MESSAGE_COMPACT_TARGET_CHARS = 240;
const UNCOMPRESSED_RECENT_MESSAGES = 2;
const MEDIA_MESSAGE_PATTERNS = [
	{
		regex: /^(\[Audio[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous transcription compacted",
	},
	{
		regex: /^(\[Image[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous visual description compacted",
	},
	{
		regex: /^(\[YouTube video[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous summary compacted",
	},
	{
		regex: /^(\[Plain-text attachment[^\]]*\])\s*([\s\S]+)$/u,
		label: "Previous text attachment compacted",
	},
] as const;

function normalizeForCompactPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function compactMediaMessageContent(content: string): string {
	for (const pattern of MEDIA_MESSAGE_PATTERNS) {
		const match = content.match(pattern.regex);
		if (!match) continue;

		const prefix = match[1] ?? content;
		const body = normalizeForCompactPreview(match[2] ?? "");
		if (!body) return prefix;
		if (body.startsWith(`[${pattern.label}]`)) {
			return `${prefix} ${body}`;
		}
		if (body.length <= MEDIA_MESSAGE_COMPACT_TARGET_CHARS) {
			return `${prefix} ${body}`;
		}

		const truncated = body
			.slice(0, MEDIA_MESSAGE_COMPACT_TARGET_CHARS)
			.trimEnd();
		return `${prefix} [${pattern.label}] ${truncated}...`;
	}

	return content;
}

function compactOlderMediaMessages(messages: ConversationMessage[]): void {
	const compactUntil = Math.max(
		0,
		messages.length - UNCOMPRESSED_RECENT_MESSAGES,
	);
	for (let i = 0; i < compactUntil; i++) {
		const message = messages[i];
		if (!message) continue;
		messages[i] = {
			...message,
			content: compactMediaMessageContent(message.content),
		};
	}
}

function sensoryPath(chatId: number): string {
	return `${SENSORY_DIR}/${chatId}.json`;
}

export async function loadSensory(chatId: number): Promise<SensoryBuffer> {
	try {
		const data = await readFile(sensoryPath(chatId), "utf-8");
		const buffer = sensorySchema.parse(unwrapVersioned(JSON.parse(data)));

		// Clear messages if inactive for > 3 days. The remainder is spooled for
		// episode promotion instead of being discarded — the last messages before
		// a silence are often the memorable ones. The deterministic id (derived
		// from state that only changes on save) makes repeated loads idempotent.
		if (Date.now() - buffer.lastActivity > INACTIVITY_THRESHOLD_MS) {
			if (buffer.messages.length > 0) {
				await spoolChunk({
					chatId,
					messages: buffer.messages,
					reason: "inactivity-wipe",
					id: `wipe_${chatId}_${buffer.lastActivity}_${buffer.messages.length}`,
				});
			}
			buffer.messages = [];
		}

		return buffer;
	} catch (err) {
		if (!isFileNotFound(err)) {
			throw err;
		}
		return {
			chatId,
			messages: [],
			lastActivity: Date.now(),
			messageCountSincePromotion: 0,
		};
	}
}

/**
 * Persist the inactivity wipe for a chat: if the on-disk buffer is still stale
 * and holds messages, save it with messages cleared. Must run before a spooled
 * inactivity-wipe chunk is promoted — otherwise a later load of the still-stale
 * buffer would re-spool the chunk after its removal, promoting it twice.
 * Preserves lastActivity (unlike saveSensory) so the follow-up/check-in
 * "active conversation" guards don't mistake a dead chat for a live one.
 * Call under withChatLock.
 */
export async function persistInactivityWipe(chatId: number): Promise<void> {
	try {
		const data = await readFile(sensoryPath(chatId), "utf-8");
		const buffer = sensorySchema.parse(unwrapVersioned(JSON.parse(data)));
		if (
			buffer.messages.length === 0 ||
			Date.now() - buffer.lastActivity <= INACTIVITY_THRESHOLD_MS
		) {
			return;
		}
		buffer.messages = [];
		buffer.schemaVersion = CURRENT_SCHEMA_VERSION;
		await writeStore(sensoryPath(chatId), buffer, sensorySchema);
	} catch (err) {
		if (!isFileNotFound(err)) throw err;
	}
}

export async function saveSensory(buffer: SensoryBuffer): Promise<void> {
	buffer.lastActivity = Date.now();
	buffer.schemaVersion = CURRENT_SCHEMA_VERSION;
	await writeStore(sensoryPath(buffer.chatId), buffer, sensorySchema);
}

/**
 * Pick how many of the oldest messages to promote on overflow. Defaults to 5,
 * but shifts to the largest time gap (>= 30 min) between consecutive messages
 * within [3, 7] so chunks end on conversation boundaries instead of mid-topic.
 */
function findOverflowSplitCount(messages: ConversationMessage[]): number {
	let bestCount = SENSORY_OVERFLOW_COUNT;
	let bestGap = 0;
	for (let count = OVERFLOW_MIN_SPLIT; count <= OVERFLOW_MAX_SPLIT; count++) {
		const before = messages[count - 1];
		const after = messages[count];
		if (!before || !after) break;
		const gap = after.timestamp - before.timestamp;
		if (gap >= OVERFLOW_BOUNDARY_GAP_MS && gap > bestGap) {
			bestGap = gap;
			bestCount = count;
		}
	}
	return bestCount;
}

/**
 * Add a message to the sensory buffer.
 * Returns overflow messages (oldest 3-7, split at a conversation boundary
 * when one exists) if the buffer exceeds 10, otherwise null.
 */
export async function addMessageToSensory(
	buffer: SensoryBuffer,
	message: ConversationMessage,
	options: { minImportance?: number; source?: PromotionSource } = {},
): Promise<ConversationMessage[] | null> {
	buffer.messages.push({ ...message, id: message.id ?? randomUUID() });
	buffer.messageCountSincePromotion++;

	let overflow: ConversationMessage[] | null = null;

	if (buffer.messages.length > SENSORY_MAX_MESSAGES) {
		const splitCount = findOverflowSplitCount(buffer.messages);
		overflow = buffer.messages.slice(0, splitCount);
		// Journal first. A crash before the sensory save is recovered by commitSpooledRemoval.
		await spoolChunk({
			chatId: buffer.chatId,
			messages: overflow,
			reason: "overflow",
			minImportance: options.minImportance ?? defaultPromotionBar(),
			source: options.source ?? "active",
		});
		buffer.messages = buffer.messages.slice(splitCount);
	}

	compactOlderMediaMessages(buffer.messages);
	await saveSensory(buffer);
	return overflow;
}

/** Complete an interrupted sensory-to-spool transfer without changing activity time. Call under the chat lock. */
export async function commitSpooledRemoval(
	chatId: number,
	messages: ConversationMessage[],
): Promise<void> {
	const buffer = await readStore(
		sensoryPath(chatId),
		sensorySchema.nullable(),
		() => null,
	);
	if (!buffer) return;
	const ids = new Set(messages.map(messageIdentity));
	const remaining = buffer.messages.filter(
		(message) => !ids.has(messageIdentity(message)),
	);
	if (remaining.length === buffer.messages.length) return;
	buffer.messages = remaining;
	await writeStore(sensoryPath(chatId), buffer, sensorySchema);
}
