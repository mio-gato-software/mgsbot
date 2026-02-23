import { describe, expect, test } from "bun:test";
import { isFileNotFound, withRetry } from "../src/utils.ts";

describe("withRetry", () => {
	test("returns result on first success", async () => {
		const result = await withRetry(() => Promise.resolve("ok"));
		expect(result).toBe("ok");
	});

	test("retries on 429 and succeeds", async () => {
		let attempt = 0;
		const result = await withRetry(
			() => {
				attempt++;
				if (attempt < 2) throw new Error("429 Too Many Requests");
				return Promise.resolve("ok");
			},
			3,
			10,
		);
		expect(result).toBe("ok");
		expect(attempt).toBe(2);
	});

	test("retries on 503 and succeeds", async () => {
		let attempt = 0;
		const result = await withRetry(
			() => {
				attempt++;
				if (attempt < 2) throw new Error("503 Service Unavailable");
				return Promise.resolve("ok");
			},
			3,
			10,
		);
		expect(result).toBe("ok");
		expect(attempt).toBe(2);
	});

	test("does not retry on non-retryable errors", async () => {
		let attempt = 0;
		try {
			await withRetry(
				() => {
					attempt++;
					throw new Error("400 Bad Request");
				},
				3,
				10,
			);
		} catch (err) {
			expect((err as Error).message).toBe("400 Bad Request");
		}
		expect(attempt).toBe(1);
	});

	test("throws after max attempts on retryable errors", async () => {
		let attempt = 0;
		try {
			await withRetry(
				() => {
					attempt++;
					throw new Error("429 Too Many Requests");
				},
				3,
				10,
			);
		} catch (err) {
			expect((err as Error).message).toBe("429 Too Many Requests");
		}
		expect(attempt).toBe(3);
	});

	test("uses exponential backoff timing", async () => {
		let attempt = 0;
		const start = Date.now();
		try {
			await withRetry(
				() => {
					attempt++;
					throw new Error("503 Service Unavailable");
				},
				3,
				50,
			);
		} catch {
			// expected
		}
		const elapsed = Date.now() - start;
		// First retry: 50ms, second retry: 100ms → total ~150ms
		expect(elapsed).toBeGreaterThanOrEqual(100);
		expect(attempt).toBe(3);
	});
});

describe("isFileNotFound", () => {
	test("returns true for ENOENT errors", () => {
		const err = new Error("not found") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		expect(isFileNotFound(err)).toBe(true);
	});

	test("returns false for other error codes", () => {
		const err = new Error("permission denied") as NodeJS.ErrnoException;
		err.code = "EACCES";
		expect(isFileNotFound(err)).toBe(false);
	});

	test("returns false for errors without code", () => {
		expect(isFileNotFound(new Error("oops"))).toBe(false);
	});

	test("returns false for SyntaxError (corrupt JSON)", () => {
		expect(isFileNotFound(new SyntaxError("Unexpected token"))).toBe(false);
	});

	test("returns false for non-Error values", () => {
		expect(isFileNotFound("string error")).toBe(false);
		expect(isFileNotFound(null)).toBe(false);
		expect(isFileNotFound(undefined)).toBe(false);
	});
});
