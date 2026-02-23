import { describe, expect, test } from "bun:test";
import { isSleepingHour } from "../src/handlers.ts";

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

// Image scheduler pure functions
describe("image-scheduler", () => {
	test("getTodayDateRD returns YYYY-MM-DD format", async () => {
		const { getTodayDateRD } = await import("../src/image-scheduler.ts");
		const today = getTodayDateRD();
		expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("getWeekStartRD returns YYYY-MM-DD format", async () => {
		const { getWeekStartRD } = await import("../src/image-scheduler.ts");
		const weekStart = getWeekStartRD();
		expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("getWeekStartRD returns a Monday", async () => {
		const { getWeekStartRD } = await import("../src/image-scheduler.ts");
		const weekStart = getWeekStartRD();
		const [year, month, day] = weekStart.split("-").map(Number);
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

		const testPath = "./audios/test_atomic_write.json";
		const testData = JSON.stringify({ test: true, value: 42 });

		await atomicWriteFile(testPath, testData);
		const readBack = await readFile(testPath, "utf-8");
		expect(readBack).toBe(testData);

		// Cleanup
		await unlink(testPath).catch(() => {});
	});
});
