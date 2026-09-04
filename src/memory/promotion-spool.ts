import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { z } from "zod";
import type { LongTermMemoryUpdate } from "../ai/evaluation.ts";
import { log } from "../logger.ts";
import { withPersistenceLock } from "../persistence-coordination.ts";
import { memoryPath } from "../runtime-paths.ts";
import type {
	ConversationMessage,
	Episode,
	PersonalitySignals,
	SemanticFact,
} from "../types.ts";
import { isFileNotFound } from "../utils.ts";
import { withPromotionSpoolLock } from "./locks.ts";
import type { PromotionSource } from "./promotion-metrics.ts";
import { episodeSchema, factsSchema, messageSchema } from "./schemas.ts";
import { readStore, writeStore } from "./storage.ts";

export const PROMOTION_SPOOL_DIR = memoryPath("promotion-spool");

export const MAX_PROMOTION_ATTEMPTS = 10;

export interface PreparedPromotion {
	narrative?: LongTermMemoryUpdate;
	narrativeBase?: { relationship: string; chapter: string };
	episode: Episode;
	facts: SemanticFact[];
	personalitySignals?: PersonalitySignals;
	recentText: string;
}
const preparedSchema = z.object({
	narrativeBase: z
		.object({ relationship: z.string(), chapter: z.string() })
		.optional(),
	narrative: z
		.object({
			relationship: z.object({
				summary: z.string(),
				tone: z.string(),
				notableDynamics: z.array(z.string()),
				openThreads: z.array(z.string()),
			}),
			chapter: z.object({
				title: z.string(),
				summary: z.string(),
				importance: z.number().min(1).max(5),
			}),
		})
		.optional(),
	episode: episodeSchema,
	facts: factsSchema,
	recentText: z.string(),
	personalitySignals: z
		.object({
			traitChanges: z.array(
				z.object({
					trait: z.string(),
					delta: z.number().finite(),
					reason: z.string(),
				}),
			),
		})
		.optional(),
});
const spoolSchema = z.array(
	z
		.object({
			id: z.string(),
			chatId: z.number(),
			messages: z.array(messageSchema),
			reason: z.enum(["promotion-failed", "inactivity-wipe", "overflow"]),
			minImportance: z.number().min(1).max(5).optional(),
			source: z.enum(["active", "passive"]).optional(),
			spooledAt: z.number(),
			attempts: z.number().int().nonnegative(),
			prepared: preparedSchema.optional(),
			failed: z.boolean().optional(),
		})
		.passthrough(),
);

export function messageIdentity(message: ConversationMessage): string {
	return (
		message.id ??
		createHash("sha256")
			.update(
				JSON.stringify([
					message.timestamp,
					message.role,
					message.name ?? null,
					message.userId ?? null,
					message.content,
				]),
			)
			.digest("hex")
	);
}
export function promotionId(
	chatId: number,
	messages: ConversationMessage[],
): string {
	return `chunk_${createHash("sha256")
		.update(`${chatId}:${messages.map(messageIdentity).join(":")}`)
		.digest("hex")}`;
}

export interface SpooledChunk {
	id: string;
	chatId: number;
	messages: ConversationMessage[];
	reason: "promotion-failed" | "inactivity-wipe" | "overflow";
	prepared?: PreparedPromotion;
	failed?: boolean;
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
	return readStore(spoolPath(chatId), spoolSchema, () => []);
}

async function saveSpool(
	chatId: number,
	chunks: SpooledChunk[],
): Promise<void> {
	if (chunks.length === 0) {
		await withPersistenceLock(() => unlink(spoolPath(chatId))).catch((err) => {
			if (!isFileNotFound(err)) throw err;
		});
		return;
	}
	await writeStore(spoolPath(chatId), chunks, spoolSchema, true);
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
		const id = input.id ?? promotionId(input.chatId, input.messages);
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
		await saveSpool(input.chatId, chunks);
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
		if (chunk.attempts >= MAX_PROMOTION_ATTEMPTS) chunk.failed = true;
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

/** Checkpoint generated content before applying effects to any store. */
export async function savePreparedPromotion(
	chatId: number,
	id: string,
	prepared: PreparedPromotion,
): Promise<void> {
	await withPromotionSpoolLock(chatId, async () => {
		const chunks = await loadPromotionSpool(chatId);
		const chunk = chunks.find((item) => item.id === id);
		if (!chunk) throw new Error(`Missing promotion journal entry: ${id}`);
		chunk.prepared = prepared;
		await saveSpool(chatId, chunks);
	});
}
