import { describe, expect, test } from "bun:test";
import {
	BOT_TZ,
	getBotHour,
	getBotMinute,
	getDateString,
} from "../src/bot-time.ts";
import {
	clampToReasonableHours,
	getLastSendTime,
	getSendsToday,
} from "../src/follow-ups.ts";
import type { FollowUp } from "../src/types.ts";

// Fixed expectations assume the default timezone (America/Santo_Domingo,
// UTC-4 year-round). Local time h:m == UTC h+4:m.
const isDefaultTz = BOT_TZ === "America/Santo_Domingo";
const describeDefaultTz = isDefaultTz ? describe : describe.skip;

function localTs(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute = 0,
): number {
	return Date.UTC(year, month, day, hour + 4, minute);
}

describeDefaultTz("clampToReasonableHours", () => {
	test("daytime timestamps pass through unchanged", () => {
		const ts = localTs(2026, 5, 10, 14, 30);
		expect(clampToReasonableHours(ts)).toBe(ts);
	});

	test("8:00 AM and 9:30 PM are inclusive boundaries", () => {
		const morning = localTs(2026, 5, 10, 8, 0);
		const night = localTs(2026, 5, 10, 21, 30);
		expect(clampToReasonableHours(morning)).toBe(morning);
		expect(clampToReasonableHours(night)).toBe(night);
	});

	test("after 9:30 PM moves to 9:00 AM the next day", () => {
		const clamped = clampToReasonableHours(localTs(2026, 5, 10, 21, 31));
		expect(getDateString(clamped)).toBe("2026-06-11");
		expect(getBotHour(clamped)).toBe(9);
		expect(getBotMinute(clamped)).toBe(0);
	});

	test("late night (11 PM) moves to 9:00 AM the next day", () => {
		const clamped = clampToReasonableHours(localTs(2026, 5, 10, 23, 15));
		expect(getDateString(clamped)).toBe("2026-06-11");
		expect(getBotHour(clamped)).toBe(9);
	});

	test("before 8 AM moves to 9:00 AM the same day", () => {
		const clamped = clampToReasonableHours(localTs(2026, 5, 10, 6, 45));
		expect(getDateString(clamped)).toBe("2026-06-10");
		expect(getBotHour(clamped)).toBe(9);
		expect(getBotMinute(clamped)).toBe(0);
	});
});

function makeFollowUp(overrides: Partial<FollowUp>): FollowUp {
	return {
		id: "fu_test",
		chatId: 1,
		event: "ir al cine",
		followUpQuestion: "¿Qué tal la película?",
		detectedAt: 0,
		scheduledFor: 0,
		status: "pending",
		attempts: 0,
		...overrides,
	};
}

describe("getSendsToday", () => {
	test("counts only follow-ups sent today", () => {
		const now = Date.now();
		const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
		const all = [
			makeFollowUp({ status: "sent", sentAt: now }),
			makeFollowUp({ status: "sent", sentAt: twoDaysAgo }),
			makeFollowUp({ status: "pending", detectedAt: now }),
			makeFollowUp({ status: "cancelled", detectedAt: now }),
		];
		expect(getSendsToday(all)).toBe(1);
	});

	test("falls back to scheduledFor for legacy entries without sentAt", () => {
		const now = Date.now();
		const all = [makeFollowUp({ status: "sent", scheduledFor: now })];
		expect(getSendsToday(all)).toBe(1);
	});

	test("empty list counts zero", () => {
		expect(getSendsToday([])).toBe(0);
	});
});

describe("getLastSendTime", () => {
	test("returns the send time of the most recent sent follow-up", () => {
		const all = [
			makeFollowUp({ status: "sent", scheduledFor: 150, sentAt: 180 }),
			makeFollowUp({ status: "sent", scheduledFor: 90, sentAt: 120 }),
			makeFollowUp({ status: "pending", detectedAt: 999, scheduledFor: 999 }),
		];
		expect(getLastSendTime(all)).toBe(180);
	});

	test("falls back to scheduledFor for legacy entries without sentAt", () => {
		const all = [
			makeFollowUp({ status: "sent", detectedAt: 100, scheduledFor: 150 }),
		];
		expect(getLastSendTime(all)).toBe(150);
	});

	test("returns 0 when nothing has been sent", () => {
		const all = [makeFollowUp({ status: "pending", detectedAt: 100 })];
		expect(getLastSendTime(all)).toBe(0);
	});
});
