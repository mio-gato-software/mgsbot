import { describe, expect, test } from "bun:test";
import { withChatLock } from "../src/memory/locks.ts";

describe("withChatLock", () => {
	test("serializes operations for the same chatId", async () => {
		const chatId = 1;
		const log: string[] = [];

		async function op(label: string, delayMs: number): Promise<void> {
			log.push(`${label}:start`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			log.push(`${label}:end`);
		}

		// Launch three ops concurrently under the same lock.
		const p1 = withChatLock(chatId, () => op("A", 20));
		const p2 = withChatLock(chatId, () => op("B", 5));
		const p3 = withChatLock(chatId, () => op("C", 10));
		await Promise.all([p1, p2, p3]);

		expect(log).toEqual([
			"A:start",
			"A:end",
			"B:start",
			"B:end",
			"C:start",
			"C:end",
		]);
	});

	test("different chatIds run in parallel", async () => {
		const log: string[] = [];
		const start = Date.now();

		const p1 = withChatLock(10, async () => {
			log.push("chat10:start");
			await new Promise((r) => setTimeout(r, 30));
			log.push("chat10:end");
		});
		const p2 = withChatLock(20, async () => {
			log.push("chat20:start");
			await new Promise((r) => setTimeout(r, 30));
			log.push("chat20:end");
		});
		await Promise.all([p1, p2]);

		const elapsed = Date.now() - start;
		// Both ops sleep 30ms. If parallel, total ≈ 30-60ms; if serial, ≈ 60+.
		expect(elapsed).toBeLessThan(60);
		expect(log).toContain("chat10:start");
		expect(log).toContain("chat20:start");
	});

	test("a failing op does not poison the queue", async () => {
		const chatId = 99;
		const log: string[] = [];

		const p1 = withChatLock(chatId, async () => {
			throw new Error("boom");
		}).catch(() => log.push("A:caught"));

		const p2 = withChatLock(chatId, async () => {
			log.push("B:ran");
		});

		await Promise.all([p1, p2]);
		// Both must have run; exact ordering between A's rejection handler and
		// B's op depends on microtask scheduling, so just assert presence.
		expect(log).toContain("A:caught");
		expect(log).toContain("B:ran");
	});

	test("returns the op result", async () => {
		const result = await withChatLock(7, async () => 42);
		expect(result).toBe(42);
	});
});
