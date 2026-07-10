import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	alertOwner,
	errorSummary,
	resetAlertState,
	setAlertSink,
} from "../src/alerts.ts";

afterEach(() => {
	setAlertSink(null);
	resetAlertState();
});

describe("alertOwner", () => {
	test("is a no-op without a sink", async () => {
		await expect(alertOwner("key", "message")).resolves.toBeUndefined();
	});

	test("sends through the sink with key prefix", async () => {
		const sent: string[] = [];
		setAlertSink(async (text) => {
			sent.push(text);
		});
		await alertOwner("bot-middleware", "boom");
		expect(sent).toEqual(["[alert:bot-middleware] boom"]);
	});

	test("cooldown suppresses repeat sends for the same key", async () => {
		const sent: string[] = [];
		setAlertSink(async (text) => {
			sent.push(text);
		});
		await alertOwner("chat-provider", "first");
		await alertOwner("chat-provider", "second");
		await alertOwner("chat-provider", "third");
		expect(sent).toEqual(["[alert:chat-provider] first"]);
	});

	test("different keys are rate-limited independently", async () => {
		const sent: string[] = [];
		setAlertSink(async (text) => {
			sent.push(text);
		});
		await alertOwner("a", "one");
		await alertOwner("b", "two");
		expect(sent).toHaveLength(2);
	});

	test("sends again after the cooldown elapses", async () => {
		const sent: string[] = [];
		setAlertSink(async (text) => {
			sent.push(text);
		});
		await alertOwner("key", "first", 0);
		await alertOwner("key", "second", 0);
		expect(sent).toHaveLength(2);
	});

	test("never throws when the sink fails", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		setAlertSink(async () => {
			throw new Error("telegram down");
		});
		await expect(alertOwner("key", "message")).resolves.toBeUndefined();
		errorSpy.mockRestore();
	});
});

describe("errorSummary", () => {
	test("formats Error as name: message without stack", () => {
		const summary = errorSummary(new TypeError("bad input"));
		expect(summary).toBe("TypeError: bad input");
	});

	test("stringifies non-Error values", () => {
		expect(errorSummary("plain failure")).toBe("plain failure");
	});

	test("truncates very long messages", () => {
		const summary = errorSummary(new Error("x".repeat(1000)));
		expect(summary.length).toBeLessThan(500);
	});
});
