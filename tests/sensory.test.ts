import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import {
	loadPromotionSpool,
	PROMOTION_SPOOL_DIR,
} from "../src/memory/promotion-spool.ts";
import {
	addMessageToSensory,
	loadSensory,
	persistInactivityWipe,
	SENSORY_DIR,
} from "../src/memory/sensory.ts";
import type { ConversationMessage, SensoryBuffer } from "../src/types.ts";

// Distinct fixture ID within the disposable test memory root.
const TEST_CHAT_ID = 999_999_901;

async function cleanup(): Promise<void> {
	for (const path of [
		`${SENSORY_DIR}/${TEST_CHAT_ID}.json`,
		`${PROMOTION_SPOOL_DIR}/${TEST_CHAT_ID}.json`,
	]) {
		if (existsSync(path)) await unlink(path);
	}
}

function makeBuffer(messages: ConversationMessage[] = []): SensoryBuffer {
	return {
		chatId: TEST_CHAT_ID,
		messages,
		lastActivity: Date.now(),
		messageCountSincePromotion: 0,
	};
}

function userMsg(content: string, i: number): ConversationMessage {
	return {
		role: "user",
		name: "tester",
		content,
		timestamp: Date.now() + i,
	};
}

describe("sensory buffer", () => {
	afterEach(cleanup);

	test("loadSensory returns empty buffer when file is missing", async () => {
		await cleanup();
		const buf = await loadSensory(TEST_CHAT_ID);
		expect(buf.chatId).toBe(TEST_CHAT_ID);
		expect(buf.messages).toEqual([]);
		expect(buf.messageCountSincePromotion).toBe(0);
	});

	test("overflow returns oldest 5 when buffer exceeds 10 messages", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const buf = makeBuffer();

		// Push 10 messages — no overflow yet
		for (let i = 0; i < 10; i++) {
			const overflow = await addMessageToSensory(buf, userMsg(`msg${i}`, i));
			expect(overflow).toBeNull();
		}
		expect(buf.messages).toHaveLength(10);

		// 11th message triggers overflow
		const overflow = await addMessageToSensory(buf, userMsg("msg10", 10));
		expect(overflow).not.toBeNull();
		expect(overflow).toHaveLength(5);
		expect(overflow?.[0]?.content).toBe("msg0");
		expect(overflow?.[4]?.content).toBe("msg4");

		// Buffer keeps the newer 6 messages (10 - 5 + 1)
		expect(buf.messages).toHaveLength(6);
		expect(buf.messages[0]?.content).toBe("msg5");
		expect(buf.messages[5]?.content).toBe("msg10");
	});

	test("media messages are compacted once they are not among the most recent 2", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const longTranscript = "lorem ipsum ".repeat(60).trim();
		const buf = makeBuffer();

		// The old media message
		await addMessageToSensory(
			buf,
			userMsg(`[Audio from tester]: ${longTranscript}`, 0),
		);
		// Two more messages push the media message out of the "recent 2" window
		await addMessageToSensory(buf, userMsg("ok", 1));
		await addMessageToSensory(buf, userMsg("vale", 2));

		const first = buf.messages[0];
		if (!first) throw new Error("expected a first message");
		expect(first.content.startsWith("[Audio from tester]:")).toBe(true);
		expect(first.content).toContain("[Previous transcription compacted]");
		expect(first.content.length).toBeLessThan(longTranscript.length);
	});

	test("plain-text attachments are compacted once they are not among the most recent 2", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const longText = "lorem ipsum ".repeat(60).trim();
		const buf = makeBuffer();

		await addMessageToSensory(
			buf,
			userMsg(
				`[Plain-text attachment from tester, file: "notes.txt"]\n\n${longText}`,
				0,
			),
		);
		await addMessageToSensory(buf, userMsg("ok", 1));
		await addMessageToSensory(buf, userMsg("vale", 2));

		const first = buf.messages[0];
		if (!first) throw new Error("expected a first message");
		expect(first.content.startsWith("[Plain-text attachment from tester")).toBe(
			true,
		);
		expect(first.content).toContain("[Previous text attachment compacted]");
		expect(first.content.length).toBeLessThan(longText.length);
	});

	test("messageCountSincePromotion increments on every append", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const buf = makeBuffer();
		await addMessageToSensory(buf, userMsg("a", 0));
		await addMessageToSensory(buf, userMsg("b", 1));
		await addMessageToSensory(buf, userMsg("c", 2));
		expect(buf.messageCountSincePromotion).toBe(3);
	});

	test("overflow splits at a large time gap instead of a hard 5", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const base = Date.now();
		const buf = makeBuffer();

		// Messages 0-6 are one burst; a 45-min gap separates message 6 from 7.
		for (let i = 0; i < 10; i++) {
			const gap = i >= 7 ? 45 * 60 * 1000 : 0;
			const overflow = await addMessageToSensory(buf, {
				role: "user",
				name: "tester",
				content: `msg${i}`,
				timestamp: base + i * 1000 + gap,
			});
			expect(overflow).toBeNull();
		}

		const overflow = await addMessageToSensory(buf, {
			role: "user",
			name: "tester",
			content: "msg10",
			timestamp: base + 10 * 1000 + 45 * 60 * 1000,
		});

		// The chunk ends at the conversation boundary (7 messages), not at 5.
		expect(overflow).toHaveLength(7);
		expect(overflow?.[6]?.content).toBe("msg6");
		expect(buf.messages[0]?.content).toBe("msg7");
	});

	test("overflow keeps the default 5-message split when no boundary exists", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const buf = makeBuffer();
		for (let i = 0; i < 10; i++) {
			await addMessageToSensory(buf, userMsg(`msg${i}`, i));
		}
		const overflow = await addMessageToSensory(buf, userMsg("msg10", 10));
		expect(overflow).toHaveLength(5);
	});

	test("inactivity wipe spools the remainder instead of discarding it", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const staleBuffer: SensoryBuffer = {
			chatId: TEST_CHAT_ID,
			messages: [userMsg("see you at the wedding", 0), userMsg("saturday!", 1)],
			lastActivity: Date.now() - 4 * 24 * 60 * 60 * 1000, // 4 days ago
			messageCountSincePromotion: 2,
		};
		await writeFile(
			`${SENSORY_DIR}/${TEST_CHAT_ID}.json`,
			JSON.stringify(staleBuffer),
		);

		const loaded = await loadSensory(TEST_CHAT_ID);
		expect(loaded.messages).toEqual([]);

		const chunks = await loadPromotionSpool(TEST_CHAT_ID);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.reason).toBe("inactivity-wipe");
		expect(chunks[0]?.messages).toHaveLength(2);
		expect(chunks[0]?.messages[0]?.content).toBe("see you at the wedding");

		// Repeated loads before the next save must not duplicate the chunk.
		await loadSensory(TEST_CHAT_ID);
		expect(await loadPromotionSpool(TEST_CHAT_ID)).toHaveLength(1);
	});

	test("persistInactivityWipe clears messages but preserves lastActivity", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const staleTimestamp = Date.now() - 4 * 24 * 60 * 60 * 1000;
		const staleBuffer: SensoryBuffer = {
			chatId: TEST_CHAT_ID,
			messages: [userMsg("bye", 0)],
			lastActivity: staleTimestamp,
			messageCountSincePromotion: 1,
		};
		const path = `${SENSORY_DIR}/${TEST_CHAT_ID}.json`;
		await writeFile(path, JSON.stringify(staleBuffer));

		await persistInactivityWipe(TEST_CHAT_ID);

		const onDisk = JSON.parse(await Bun.file(path).text()) as SensoryBuffer;
		expect(onDisk.messages).toEqual([]);
		expect(onDisk.lastActivity).toBe(staleTimestamp);
	});

	test("persistInactivityWipe leaves fresh buffers untouched", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const freshBuffer: SensoryBuffer = {
			chatId: TEST_CHAT_ID,
			messages: [userMsg("hola", 0)],
			lastActivity: Date.now(),
			messageCountSincePromotion: 1,
		};
		const path = `${SENSORY_DIR}/${TEST_CHAT_ID}.json`;
		await writeFile(path, JSON.stringify(freshBuffer));

		await persistInactivityWipe(TEST_CHAT_ID);

		const onDisk = JSON.parse(await Bun.file(path).text()) as SensoryBuffer;
		expect(onDisk.messages).toHaveLength(1);
	});
});
