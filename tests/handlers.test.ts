import { describe, expect, test } from "bun:test";
import {
	buildReplyAwareTextContent,
	isSleepingHour,
	type TelegramReplyContext,
} from "../src/handlers.ts";
import { memoryPath } from "../src/runtime-paths.ts";

describe("isSleepingHour", () => {
	test("returns a boolean", () => {
		expect(typeof isSleepingHour()).toBe("boolean");
	});
});

// detectMentionType requires a full grammy Context which is hard to mock
// in unit tests. We test the exported function signature exists.
describe("detectMentionType", () => {
	test("is exported from handlers", async () => {
		const mod = await import("../src/handlers.ts");
		expect(typeof mod.detectMentionType).toBe("function");
	});
});

describe("buildReplyAwareTextContent", () => {
	test("preserves Telegram reply target context", () => {
		const replyContext: TelegramReplyContext = {
			senderName: "Juan Ejemplo",
			content: "El documento ya está listo.",
			isBot: false,
		};

		expect(
			buildReplyAwareTextContent("¿Puedes revisarlo?", replyContext),
		).toBe(`[Replying to Juan Ejemplo: "El documento ya está listo."]

¿Puedes revisarlo?`);
	});

	test("marks replies to the bot explicitly", () => {
		const replyContext: TelegramReplyContext = {
			senderName: "DemoBot",
			content: "El archivo tiene tres páginas.",
			isBot: true,
		};

		expect(
			buildReplyAwareTextContent("Gracias", replyContext),
		).toBe(`[Replying to DemoBot (bot): "El archivo tiene tres páginas."]

Gracias`);
	});
});

// Image scheduler pure functions
describe("image-scheduler", () => {
	test("getTodayDate returns YYYY-MM-DD format", async () => {
		const { getTodayDate } = await import("../src/image-scheduler.ts");
		const today = getTodayDate();
		expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("getWeekStart returns YYYY-MM-DD format", async () => {
		const { getWeekStart } = await import("../src/image-scheduler.ts");
		const weekStart = getWeekStart();
		expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("getWeekStart returns a Monday", async () => {
		const { getWeekStart } = await import("../src/image-scheduler.ts");
		const weekStart = getWeekStart();
		const [year = 1970, month = 1, day = 1] = weekStart.split("-").map(Number);
		const date = new Date(year, month - 1, day);
		expect(date.getDay()).toBe(1); // Monday
	});

	test("generateRandomWeeklyTargetTime returns valid ISO string", async () => {
		const { generateRandomWeeklyTargetTime } = await import(
			"../src/image-scheduler.ts"
		);
		const target = generateRandomWeeklyTargetTime();
		const date = new Date(target);
		expect(date.getTime()).not.toBeNaN();
	});
});

// atomicWriteFile integration test
describe("atomicWriteFile", () => {
	test("writes and reads back correctly", async () => {
		const { atomicWriteFile } = await import("../src/utils.ts");
		const { readFile, unlink } = await import("node:fs/promises");

		const testPath = memoryPath("test_atomic_write.json");
		const testData = JSON.stringify({ test: true, value: 42 });

		await atomicWriteFile(testPath, testData);
		const readBack = await readFile(testPath, "utf-8");
		expect(readBack).toBe(testData);

		// Cleanup
		await unlink(testPath).catch(() => {});
	});
});

test("paused messages stop before handlers that download or analyze media", async () => {
	const { setBotOff } = await import("../src/bot-state.ts");
	const { pausedMessageMiddleware } = await import("../src/handlers.ts");
	const { makeMockContext } = await import("./helpers/telegram-mock.ts");
	setBotOff(true);
	try {
		for (const message of [
			{ voice: { file_id: "voice" } },
			{ document: { file_id: "pdf", mime_type: "application/pdf" } },
			{ photo: [{ file_id: "photo", width: 32, height: 32 }] },
		]) {
			const { ctx, spies } = makeMockContext(message);
			await pausedMessageMiddleware(ctx, async () => {
				throw Error("Paused content reached a media handler");
			});
			expect(spies.reactions).toHaveLength(1);
		}
		const group = makeMockContext({ chatType: "group", text: "Hola a todos" });
		await pausedMessageMiddleware(group.ctx, async () => {
			throw Error("Paused content reached a group handler");
		});
		expect(group.spies.reactions).toHaveLength(0);
	} finally {
		setBotOff(false);
	}
	const { ctx } = makeMockContext({ text: "Hola" });
	let resumed = false;
	await pausedMessageMiddleware(ctx, async () => {
		resumed = true;
	});
	expect(resumed).toBe(true);
});
