import { readdir, readFile, unlink } from "node:fs/promises";
import { log } from "../logger.ts";
import type { ConversationMessage } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { withPromotionSpoolLock } from "./locks.ts";
import type { PromotionSource } from "./promotion-metrics.ts";
import { unwrapVersioned, wrapVersioned } from "./versioning.ts";

export const PROMOTION_SPOOL_DIR = "./memory/promotion-spool";

// A chat whose promotions keep failing drops its oldest chunks first.
const MAX_SPOOLED_CHUNKS_PER_CHAT = 20;

export interface SpooledChunk {
	id: string;
	chatId: number;
	messages: ConversationMessage[];
	reason: "promotion-failed" | "inactivity-wipe";
	/** Importance bar the chunk was originally promoted under (see promoteToMemory). */
	minImportance?: number;
	/** Promotion path the chunk came from, kept so retries stay attributable. */
	source?: PromotionSource;
	spooledAt: number;
	attempts: number;
}

function spoolPath(chatId: number): string {
	return `${PROMOTION_SPOOL_DIR}/${chatId}.json`;
}

export async function loadPromotionSpool(
	chatId: number,
): Promise<SpooledChunk[]> {
	try {
		const data = await readFile(spoolPath(chatId), "utf-8");
		return unwrapVersioned<SpooledChunk[]>(JSON.parse(data));
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error(`[spool] Error loading promotion spool ${chatId}:`, err);
		}
		return [];
	}
}

async function saveSpool(
	chatId: number,
	chunks: SpooledChunk[],
): Promise<void> {
	if (chunks.length === 0) {
		await unlink(spoolPath(chatId)).catch((err) => {
			if (!isFileNotFound(err)) throw err;
		});
		return;
	}
	await atomicWriteFile(
		spoolPath(chatId),
		JSON.stringify(wrapVersioned(chunks), null, 2),
	);
}

/**
 * Persist an unpromoted message chunk so it can be retried later.
 * Idempotent per id: spooling the same id twice keeps the first entry, so
 * repeated stale-buffer loads can't duplicate a chunk.
 */
export async function spoolChunk(input: {
	chatId: number;
	messages: ConversationMessage[];
	reason: SpooledChunk["reason"];
	id?: string;
	minImportance?: number;
	source?: PromotionSource;
}): Promise<void> {
	if (input.messages.length === 0) return;
	await withPromotionSpoolLock(input.chatId, async () => {
		const chunks = await loadPromotionSpool(input.chatId);
		const id =
			input.id ??
			`chunk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		if (chunks.some((chunk) => chunk.id === id)) return;
		chunks.push({
			id,
			chatId: input.chatId,
			messages: input.messages,
			reason: input.reason,
			minImportance: input.minImportance,
			source: input.source,
			spooledAt: Date.now(),
			attempts: 0,
		});
		const bounded = chunks.slice(-MAX_SPOOLED_CHUNKS_PER_CHAT);
		if (bounded.length < chunks.length) {
			log.warn(
				`[spool] Spool full for chat ${input.chatId} — dropped ${chunks.length - bounded.length} oldest chunk(s)`,
			);
		}
		await saveSpool(input.chatId, bounded);
	});
}

export async function removeSpooledChunk(
	chatId: number,
	id: string,
): Promise<void> {
	await withPromotionSpoolLock(chatId, async () => {
		const chunks = await loadPromotionSpool(chatId);
		const remaining = chunks.filter((chunk) => chunk.id !== id);
		if (remaining.length !== chunks.length) {
			await saveSpool(chatId, remaining);
		}
	});
}

/**
 * Increment a chunk's retry counter. Returns the new count, or 0 if the
 * chunk no longer exists (e.g., removed by a concurrent drain).
 */
export async function recordSpoolAttempt(
	chatId: number,
	id: string,
): Promise<number> {
	return withPromotionSpoolLock(chatId, async () => {
		const chunks = await loadPromotionSpool(chatId);
		const chunk = chunks.find((c) => c.id === id);
		if (!chunk) return 0;
		chunk.attempts += 1;
		await saveSpool(chatId, chunks);
		return chunk.attempts;
	});
}

export async function listSpooledChatIds(): Promise<number[]> {
	try {
		const files = await readdir(PROMOTION_SPOOL_DIR);
		return files
			.filter((file) => file.endsWith(".json"))
			.map((file) => Number.parseInt(file.slice(0, -".json".length), 10))
			.filter((id) => Number.isFinite(id));
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[spool] Error listing promotion spool:", err);
		}
		return [];
	}
}
