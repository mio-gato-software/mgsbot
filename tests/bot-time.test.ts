import { describe, expect, test } from "bun:test";
import {
	BOT_TZ,
	botNow,
	getBotDay,
	getBotHour,
	getBotMinute,
	getDateString,
} from "../src/bot-time.ts";

// These tests assume the default timezone (America/Santo_Domingo, UTC-4
// year-round, no DST). If BOT_TIMEZONE is set in the environment the
// fixed expectations below would not apply, so we skip in that case.
const isDefaultTz = BOT_TZ === "America/Santo_Domingo";
const describeDefaultTz = isDefaultTz ? describe : describe.skip;

describeDefaultTz("bot-time (America/Santo_Domingo, UTC-4)", () => {
	test("converts UTC to bot-local hour and minute", () => {
		// 2026-06-10 18:45 UTC → 14:45 local
		const ts = Date.UTC(2026, 5, 10, 18, 45);
		expect(getBotHour(ts)).toBe(14);
		expect(getBotMinute(ts)).toBe(45);
	});

	test("crosses midnight backward into the previous local day", () => {
		// 2026-01-01 02:30 UTC → 2025-12-31 22:30 local
		const ts = Date.UTC(2026, 0, 1, 2, 30);
		expect(getDateString(ts)).toBe("2025-12-31");
		expect(getBotHour(ts)).toBe(22);
		expect(getBotMinute(ts)).toBe(30);
	});

	test("local midnight boundary belongs to the new local day", () => {
		// 04:00 UTC == 00:00 local
		const ts = Date.UTC(2026, 5, 11, 4, 0);
		expect(getDateString(ts)).toBe("2026-06-11");
		expect(getBotHour(ts)).toBe(0);
	});

	test("getBotDay matches the local weekday", () => {
		// 2026-06-10 12:00 UTC is a Wednesday both in UTC and UTC-4
		expect(getBotDay(Date.UTC(2026, 5, 10, 12, 0))).toBe(3);
		// 2026-06-08 01:00 UTC (Monday) → Sunday 21:00 local
		expect(getBotDay(Date.UTC(2026, 5, 8, 1, 0))).toBe(0);
	});

	test("getDateString formats as YYYY-MM-DD", () => {
		const ts = Date.UTC(2026, 2, 5, 12, 0);
		expect(getDateString(ts)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(getDateString(ts)).toBe("2026-03-05");
	});

	test("botNow round-trips the same instant", () => {
		const ts = Date.UTC(2026, 5, 10, 18, 45);
		expect(botNow(ts).valueOf()).toBe(ts);
	});
});
