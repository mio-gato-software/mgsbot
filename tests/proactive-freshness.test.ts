import { describe, expect, test } from "bun:test";
import { hasUserMessageSince, pickStrategy } from "../src/check-ins.ts";
import {
	EVENT_DEDUP_WINDOW_MS,
	isDuplicateOfRecentFollowUp,
} from "../src/follow-ups.ts";
import type { ConversationMessage, FollowUp } from "../src/types.ts";

function makeFollowUp(overrides: Partial<FollowUp>): FollowUp {
	return {
		id: "fu_test",
		chatId: 1,
		event: "comer camarones con Ada",
		followUpQuestion: "¿Qué tal los camarones?",
		detectedAt: 0,
		scheduledFor: 0,
		status: "sent",
		attempts: 1,
		...overrides,
	};
}

describe("isDuplicateOfRecentFollowUp", async () => {
	const now = Date.now();
	const matched: Parameters<typeof isDuplicateOfRecentFollowUp>[4] = async (
		_mode,
		_text,
		candidates,
	) => new Set(candidates.map(({ id }) => id));
	const unrelated: typeof matched = async () => new Set();

	test("blocks a similar event tracked within the window", async () => {
		const all = [
			makeFollowUp({ event: "comer camarones con Ada", detectedAt: now }),
		];
		expect(
			await isDuplicateOfRecentFollowUp(
				all,
				1,
				"los camarones que hizo Ada",
				now,
				matched,
			),
		).toBe(true);
	});

	test("blocks regardless of status (cancelled/expired count too)", async () => {
		const all = [makeFollowUp({ status: "expired", detectedAt: now - 1000 })];
		expect(
			await isDuplicateOfRecentFollowUp(
				all,
				1,
				"comer camarones",
				now,
				matched,
			),
		).toBe(true);
	});

	test("allows the same topic once the window has passed", async () => {
		const stale = now - EVENT_DEDUP_WINDOW_MS - 1000;
		const all = [makeFollowUp({ detectedAt: stale })];
		expect(
			await isDuplicateOfRecentFollowUp(
				all,
				1,
				"comer camarones con Ada",
				now,
				matched,
			),
		).toBe(false);
	});

	test("uses sentAt when it is more recent than detectedAt", async () => {
		const all = [
			makeFollowUp({
				detectedAt: now - EVENT_DEDUP_WINDOW_MS - 1000,
				sentAt: now - 1000,
			}),
		];
		expect(
			await isDuplicateOfRecentFollowUp(
				all,
				1,
				"comer camarones con Ada",
				now,
				matched,
			),
		).toBe(true);
	});

	test("allows unrelated events", async () => {
		const all = [makeFollowUp({ detectedAt: now })];
		expect(
			await isDuplicateOfRecentFollowUp(
				all,
				1,
				"cita con el dentista mañana",
				now,
				unrelated,
			),
		).toBe(false);
	});
});

describe("hasUserMessageSince", () => {
	const base = 1_000_000;
	function msg(role: "user" | "model", timestamp: number): ConversationMessage {
		return { role, content: "x", timestamp };
	}

	test("true when a user message follows the timestamp", () => {
		const messages = [msg("model", base), msg("user", base + 1)];
		expect(hasUserMessageSince(messages, base)).toBe(true);
	});

	test("false when only bot messages follow", () => {
		const messages = [msg("user", base - 10), msg("model", base + 5)];
		expect(hasUserMessageSince(messages, base)).toBe(false);
	});

	test("false on empty buffer", () => {
		expect(hasUserMessageSince([], base)).toBe(false);
	});
});

describe("pickStrategy exclusions", () => {
	test("never picks an excluded strategy", () => {
		for (let i = 0; i < 50; i++) {
			expect(pickStrategy([], ["memory_callback"])).not.toBe("memory_callback");
		}
	});

	test("exclusion still applies when recent strategies exhaust the pool", () => {
		const recent = [
			"random_thought",
			"sharing_moment",
			"reaction",
			"weather_vibe",
			"curiosity",
		];
		for (let i = 0; i < 50; i++) {
			expect(pickStrategy(recent, ["memory_callback"])).not.toBe(
				"memory_callback",
			);
		}
	});

	test("falls back to the full pool when everything is excluded", () => {
		const all = [
			"random_thought",
			"memory_callback",
			"sharing_moment",
			"reaction",
			"weather_vibe",
			"curiosity",
		];
		expect(all).toContain(pickStrategy([], all));
	});
});
