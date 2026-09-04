import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
	listSpooledChatIds,
	loadPromotionSpool,
	messageIdentity,
	PROMOTION_SPOOL_DIR,
	recordSpoolAttempt,
	removeSpooledChunk,
	spoolChunk,
} from "../src/memory/promotion-spool.ts";
import type { ConversationMessage } from "../src/types.ts";

// Distinct fixture ID within the disposable test memory root.
const TEST_CHAT_ID = 999_999_902;

async function cleanup(): Promise<void> {
	const path = `${PROMOTION_SPOOL_DIR}/${TEST_CHAT_ID}.json`;
	if (existsSync(path)) await unlink(path);
}

function messages(count: number): ConversationMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		role: "user" as const,
		name: "tester",
		content: `msg${i}`,
		timestamp: Date.now() + i,
	}));
}

describe("promotion spool", () => {
	afterEach(cleanup);

	test("legacy message identity is independent of JSON property order", () => {
		const message: ConversationMessage = {
			role: "user",
			content: "same message",
			timestamp: 123,
			name: "Ana",
		};
		const reordered: ConversationMessage = {
			name: "Ana",
			timestamp: 123,
			content: "same message",
			role: "user",
		};
		expect(messageIdentity(message)).toBe(messageIdentity(reordered));
		expect(messageIdentity({ ...message, content: "different" })).not.toBe(
			messageIdentity(message),
		);
	});

	test("spooled chunk round-trips through load", async () => {
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: messages(3),
			reason: "promotion-failed",
			minImportance: 3,
		});

		const chunks = await loadPromotionSpool(TEST_CHAT_ID);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.chatId).toBe(TEST_CHAT_ID);
		expect(chunks[0]?.messages).toHaveLength(3);
		expect(chunks[0]?.reason).toBe("promotion-failed");
		expect(chunks[0]?.minImportance).toBe(3);
		expect(chunks[0]?.attempts).toBe(0);
	});

	test("spooling the same id twice is idempotent", async () => {
		const input = {
			chatId: TEST_CHAT_ID,
			messages: messages(2),
			reason: "inactivity-wipe" as const,
			id: "wipe_test_1",
		};
		await spoolChunk(input);
		await spoolChunk(input);

		const chunks = await loadPromotionSpool(TEST_CHAT_ID);
		expect(chunks).toHaveLength(1);
	});

	test("empty message chunks are not spooled", async () => {
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: [],
			reason: "promotion-failed",
		});
		expect(await loadPromotionSpool(TEST_CHAT_ID)).toHaveLength(0);
	});

	test("removeSpooledChunk deletes only the matching chunk", async () => {
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: messages(1),
			reason: "promotion-failed",
			id: "keep",
		});
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: messages(1),
			reason: "promotion-failed",
			id: "drop",
		});

		await removeSpooledChunk(TEST_CHAT_ID, "drop");

		const chunks = await loadPromotionSpool(TEST_CHAT_ID);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.id).toBe("keep");
	});

	test("removing the last chunk deletes the spool file", async () => {
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: messages(1),
			reason: "promotion-failed",
			id: "only",
		});
		await removeSpooledChunk(TEST_CHAT_ID, "only");
		expect(existsSync(`${PROMOTION_SPOOL_DIR}/${TEST_CHAT_ID}.json`)).toBe(
			false,
		);
	});

	test("recordSpoolAttempt increments and persists the counter", async () => {
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: messages(1),
			reason: "promotion-failed",
			id: "retryable",
		});

		expect(await recordSpoolAttempt(TEST_CHAT_ID, "retryable")).toBe(1);
		expect(await recordSpoolAttempt(TEST_CHAT_ID, "retryable")).toBe(2);
		expect(await recordSpoolAttempt(TEST_CHAT_ID, "missing")).toBe(0);

		const chunks = await loadPromotionSpool(TEST_CHAT_ID);
		expect(chunks[0]?.attempts).toBe(2);
	});

	test("listSpooledChatIds includes chats with pending chunks", async () => {
		await spoolChunk({
			chatId: TEST_CHAT_ID,
			messages: messages(1),
			reason: "inactivity-wipe",
		});
		expect(await listSpooledChatIds()).toContain(TEST_CHAT_ID);
	});
});
