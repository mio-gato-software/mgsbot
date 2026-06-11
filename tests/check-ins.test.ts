import { describe, expect, test } from "bun:test";
import { BOT_TZ, getBotHour, getBotMinute } from "../src/bot-time.ts";
import {
	clampToReasonableHours,
	generateWeeklySlots,
	getWeekStart,
	pickDaysWithGap,
} from "../src/check-ins.ts";

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

describeDefaultTz("getWeekStart", () => {
	test("mid-week date returns the preceding Monday", () => {
		// 2026-06-10 is a Wednesday
		expect(getWeekStart(localTs(2026, 5, 10, 12))).toBe("2026-06-08");
	});

	test("Monday returns itself", () => {
		expect(getWeekStart(localTs(2026, 5, 8, 12))).toBe("2026-06-08");
	});

	test("Sunday belongs to the week started the previous Monday", () => {
		// 2026-06-14 is a Sunday
		expect(getWeekStart(localTs(2026, 5, 14, 12))).toBe("2026-06-08");
	});

	test("week boundary: Sunday vs following Monday", () => {
		expect(getWeekStart(localTs(2026, 5, 14, 23))).toBe("2026-06-08");
		expect(getWeekStart(localTs(2026, 5, 15, 0))).toBe("2026-06-15");
	});
});

describeDefaultTz("clampToReasonableHours (check-ins)", () => {
	test("matches follow-ups behavior: passthrough, late, and early cases", () => {
		const day = localTs(2026, 5, 10, 15, 0);
		expect(clampToReasonableHours(day)).toBe(day);

		const late = clampToReasonableHours(localTs(2026, 5, 10, 22, 0));
		expect(getBotHour(late)).toBe(9);
		expect(getBotMinute(late)).toBe(0);

		const early = clampToReasonableHours(localTs(2026, 5, 10, 5, 0));
		expect(getBotHour(early)).toBe(9);
	});
});

describe("pickDaysWithGap", () => {
	test("respects the minimum gap when feasible", () => {
		for (let i = 0; i < 50; i++) {
			const days = pickDaysWithGap([0, 1, 2, 3, 4, 5, 6], 2, 2);
			expect(days).toHaveLength(2);
			const [a, b] = days;
			if (a === undefined || b === undefined) throw new Error("missing days");
			expect(Math.abs(a - b)).toBeGreaterThanOrEqual(2);
		}
	});

	test("returns days sorted ascending from the available set", () => {
		for (let i = 0; i < 20; i++) {
			const days = pickDaysWithGap([2, 4, 6], 3, 2);
			expect(days).toEqual([2, 4, 6]);
		}
	});

	test("relaxes the gap when it cannot be satisfied", () => {
		const days = pickDaysWithGap([0, 1, 2], 3, 2);
		expect(days).toEqual([0, 1, 2]);
	});

	test("count of zero or empty availability returns empty", () => {
		expect(pickDaysWithGap([1, 2, 3], 0, 2)).toEqual([]);
		expect(pickDaysWithGap([], 3, 2)).toEqual([]);
	});

	test("never returns more days than available", () => {
		const days = pickDaysWithGap([3, 5], 4, 2);
		expect(days).toEqual([3, 5]);
	});
});

describeDefaultTz("generateWeeklySlots", () => {
	test("slots are in the future, within reasonable hours, and capped", () => {
		for (let i = 0; i < 30; i++) {
			const slots = generateWeeklySlots(2);
			expect(slots.length).toBeLessThanOrEqual(2);
			const now = Date.now();
			for (const slot of slots) {
				expect(slot.status).toBe("pending");
				expect(slot.scheduledFor).toBeGreaterThan(now - 1000);
				const hour = getBotHour(slot.scheduledFor);
				const minute = getBotMinute(slot.scheduledFor);
				expect(hour).toBeGreaterThanOrEqual(8);
				expect(hour * 60 + minute).toBeLessThanOrEqual(21 * 60 + 30);
			}
		}
	});

	test("requesting many slots never exceeds remaining days in the week", () => {
		const slots = generateWeeklySlots(20);
		expect(slots.length).toBeLessThanOrEqual(7);
	});

	test("zero check-ins per week yields no slots", () => {
		expect(generateWeeklySlots(0)).toEqual([]);
	});
});
