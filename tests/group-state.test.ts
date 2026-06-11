import { beforeEach, describe, expect, test } from "bun:test";
import {
	canAutoReplyInGroup,
	canEvaluateSpontaneousReplyInGroup,
	claimGroupContinuationSlot,
	openGroupContinuationWindow,
	registerGroupAutoReply,
	registerSpontaneousReplyEvaluation,
	resetGroupState,
} from "../src/group-state.ts";

const CHAT = -100123;
const HOUR = 60 * 60 * 1000;
const T0 = 1_750_000_000_000;

beforeEach(() => {
	resetGroupState();
});

describe("spontaneous auto-replies", () => {
	test("allowed when no previous reply exists", () => {
		expect(canAutoReplyInGroup(CHAT, T0)).toBe(true);
	});

	test("blocked during the 4-hour cooldown after a reply", () => {
		registerGroupAutoReply(CHAT, T0);
		expect(canAutoReplyInGroup(CHAT, T0 + 1 * HOUR)).toBe(false);
		expect(canAutoReplyInGroup(CHAT, T0 + 3.9 * HOUR)).toBe(false);
	});

	test("allowed again after the cooldown expires", () => {
		registerGroupAutoReply(CHAT, T0);
		expect(canAutoReplyInGroup(CHAT, T0 + 4 * HOUR + 1)).toBe(true);
	});

	test("chats are tracked independently", () => {
		registerGroupAutoReply(CHAT, T0);
		expect(canAutoReplyInGroup(-200456, T0 + 1)).toBe(true);
	});
});

describe("spontaneous evaluation cooldown", () => {
	test("allowed initially, blocked for 10 minutes after evaluating", () => {
		expect(canEvaluateSpontaneousReplyInGroup(CHAT, T0)).toBe(true);
		registerSpontaneousReplyEvaluation(CHAT, T0);
		expect(canEvaluateSpontaneousReplyInGroup(CHAT, T0 + 5 * 60 * 1000)).toBe(
			false,
		);
		expect(canEvaluateSpontaneousReplyInGroup(CHAT, T0 + 10 * 60 * 1000)).toBe(
			true,
		);
	});
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
