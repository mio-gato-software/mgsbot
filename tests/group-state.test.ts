import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	canAutoReplyInGroup,
	claimGroupContinuationSlot,
	claimGroupSpontaneousReply,
	openGroupContinuationWindow,
	registerGroupAutoReply,
	resetGroupState,
} from "../src/group-state.ts";

const CHAT = -100123;
const MINUTE = 60_000;
const T0 = 1_750_000_000_000;
const originalEnv = { ...process.env };

beforeEach(() => {
	resetGroupState();
	process.env.ENABLE_GROUP_PERSONALITY = "true";
	delete process.env.GROUP_SPONTANEOUS_COOLDOWN_MINUTES;
});
afterEach(() => {
	process.env = { ...originalEnv };
});

describe("spontaneous auto-replies", () => {
	test("allowed when no previous reply exists", () => {
		expect(canAutoReplyInGroup(CHAT, T0)).toBe(true);
	});

	test("a delivered reply starts the default one-hour cooldown", () => {
		registerGroupAutoReply(CHAT, T0);
		expect(claimGroupSpontaneousReply(CHAT, T0 + 59 * MINUTE)).toBe(false);
		expect(claimGroupSpontaneousReply(CHAT, T0 + 60 * MINUTE)).toBe(true);
	});

	test("uses a valid custom cooldown", () => {
		process.env.GROUP_SPONTANEOUS_COOLDOWN_MINUTES = "25";
		registerGroupAutoReply(CHAT, T0);
		expect(claimGroupSpontaneousReply(CHAT, T0 + 24 * MINUTE)).toBe(false);
		expect(claimGroupSpontaneousReply(CHAT, T0 + 25 * MINUTE)).toBe(true);
	});

	test.each([
		["without opt-in", undefined, "false"],
		["with group personality disabled", "false", "false"],
		["in simple assistant mode", "true", "true"],
	] as const)(
		"retains the four-hour attempt cadence %s",
		(_mode, enabled, simple) => {
			if (enabled === undefined) delete process.env.ENABLE_GROUP_PERSONALITY;
			else process.env.ENABLE_GROUP_PERSONALITY = enabled;
			process.env.SIMPLE_ASSISTANT_MODE = simple;
			process.env.GROUP_SPONTANEOUS_COOLDOWN_MINUTES = "25";
			expect(claimGroupSpontaneousReply(CHAT, T0)).toBe(true);
			expect(claimGroupSpontaneousReply(CHAT, T0 + 239 * MINUTE)).toBe(false);
			expect(claimGroupSpontaneousReply(CHAT, T0 + 240 * MINUTE)).toBe(true);
		},
	);

	test("chats are tracked independently", () => {
		registerGroupAutoReply(CHAT, T0);
		expect(canAutoReplyInGroup(-200456, T0 + 1)).toBe(true);
	});
});

test("an undelivered attempt only starts a short generation backoff", () => {
	expect(claimGroupSpontaneousReply(CHAT, T0)).toBe(true);
	expect(canAutoReplyInGroup(CHAT, T0 + 1)).toBe(true);
	expect(claimGroupSpontaneousReply(CHAT, T0 + 5 * MINUTE)).toBe(false);
	expect(claimGroupSpontaneousReply(CHAT, T0 + 10 * MINUTE)).toBe(true);
});

test("an ongoing exchange cannot start again when its continuation budget is exhausted", () => {
	openGroupContinuationWindow(CHAT, T0);
	for (let i = 0; i < 6; i++) claimGroupContinuationSlot(CHAT, T0 + i);
	expect(claimGroupContinuationSlot(CHAT, T0 + 7)).toBe(false);
	expect(claimGroupSpontaneousReply(CHAT, T0 + 14 * MINUTE)).toBe(false);
	expect(claimGroupSpontaneousReply(CHAT, T0 + 15 * MINUTE)).toBe(true);
});

describe("continuation windows", () => {
	test("no window means no claim", () => {
		expect(claimGroupContinuationSlot(CHAT, T0)).toBe(false);
	});

	test("an open window grants up to 6 messages", () => {
		openGroupContinuationWindow(CHAT, T0);
		for (let i = 0; i < 6; i++) {
			expect(claimGroupContinuationSlot(CHAT, T0 + i)).toBe(true);
		}
		expect(claimGroupContinuationSlot(CHAT, T0 + 7)).toBe(false);
	});

	test("window expires after 15 minutes", () => {
		openGroupContinuationWindow(CHAT, T0);
		expect(claimGroupContinuationSlot(CHAT, T0 + 15 * 60 * 1000)).toBe(false);
	});

	test("reopening a window resets the message budget", () => {
		openGroupContinuationWindow(CHAT, T0);
		for (let i = 0; i < 6; i++) claimGroupContinuationSlot(CHAT, T0 + i);
		openGroupContinuationWindow(CHAT, T0 + 100);
		expect(claimGroupContinuationSlot(CHAT, T0 + 101)).toBe(true);
	});
});
