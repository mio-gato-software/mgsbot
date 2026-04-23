import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import {
	addMessageToSensory,
	loadSensory,
	SENSORY_DIR,
} from "../src/memory/sensory.ts";
import type { ConversationMessage, SensoryBuffer } from "../src/types.ts";

// Use a reserved high chatId unlikely to collide with real data.
const TEST_CHAT_ID = 999_999_901;

async function cleanup(): Promise<void> {
	const path = `${SENSORY_DIR}/${TEST_CHAT_ID}.json`;
	if (existsSync(path)) await unlink(path);
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
		expect(overflow?.[0].content).toBe("msg0");
		expect(overflow?.[4].content).toBe("msg4");

		// Buffer keeps the newer 6 messages (10 - 5 + 1)
		expect(buf.messages).toHaveLength(6);
		expect(buf.messages[0].content).toBe("msg5");
		expect(buf.messages[5].content).toBe("msg10");
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
		expect(first.content.startsWith("[Audio from tester]:")).toBe(true);
		expect(first.content).toContain("[Previous transcription compacted]");
		expect(first.content.length).toBeLessThan(longTranscript.length);
	});

	test("messageCountSincePromotion increments on every append", async () => {
		if (!existsSync(SENSORY_DIR)) await mkdir(SENSORY_DIR, { recursive: true });
		const buf = makeBuffer();
		await addMessageToSensory(buf, userMsg("a", 0));
		await addMessageToSensory(buf, userMsg("b", 1));
		await addMessageToSensory(buf, userMsg("c", 2));
		expect(buf.messageCountSincePromotion).toBe(3);
	});
});
