import dayjs from "dayjs";
import { z } from "zod";
import { BOT_TZ } from "../bot-time.ts";

export const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((date) => dayjs.utc(date).format("YYYY-MM-DD") === date);
export const scheduleSchema = z.object({
	frequency: z.enum(["once", "daily", "weekly"]),
	time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
	startDate: dateSchema,
	weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
	endDate: dateSchema.optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** Resolve each wall-clock date afresh: adding 24h would drift across DST. */
export function localTime(
	date: string,
	time: string,
	timezone = BOT_TZ,
): number {
	const parsed = dayjs.tz(`${date} ${time}`, timezone);
	if (parsed.format("YYYY-MM-DD HH:mm") !== `${date} ${time}`) return NaN;
	return parsed.valueOf();
}

export function monthDeadline(now: number, timezone = BOT_TZ): number {
	const local = dayjs.utc(now).tz(timezone);
	const next = local.add(1, "month");
	return dayjs.tz(next.format("YYYY-MM-DD HH:mm:ss"), timezone).valueOf();
}

export function scheduleDeadline(
	schedule: Schedule,
	now: number,
	timezone = BOT_TZ,
): number {
	if (schedule.frequency === "once")
		return localTime(schedule.startDate, schedule.time, timezone) + 60 * 60000;
	const cap = monthDeadline(now, timezone);
	return schedule.endDate
		? Math.min(
				cap,
				dayjs.tz(`${schedule.endDate} 23:59:59`, timezone).valueOf(),
			)
		: cap;
}

/** First occurrence strictly after `after`, never outside the finite term. */
export function nextOccurrence(
	schedule: Schedule,
	after: number,
	expiresAt: number,
	timezone = BOT_TZ,
): number | undefined {
	if (schedule.frequency === "once") {
		const due = localTime(schedule.startDate, schedule.time, timezone);
		const weekday = dayjs.utc(schedule.startDate).day();
		return due > after &&
			due <= expiresAt &&
			schedule.weekdays.includes(weekday)
			? due
			: undefined;
	}
	const localDate = dayjs.utc(after).tz(timezone).format("YYYY-MM-DD");
	const first = localDate > schedule.startDate ? localDate : schedule.startDate;
	for (let offset = 0; offset <= 32; offset++) {
		const date = dayjs.utc(first).add(offset, "day");
		if (!schedule.weekdays.includes(date.day())) continue;
		const due = localTime(date.format("YYYY-MM-DD"), schedule.time, timezone);
		if (due > expiresAt) return undefined;
		if (due > after) return due;
	}
	return undefined;
}

export function displayTime(timestamp: number, timezone = BOT_TZ): string {
	return dayjs.utc(timestamp).tz(timezone).format("YYYY-MM-DD HH:mm");
}

/** Renew from confirmation time; days are local calendar days, capped at one month. */
export function renewalDeadline(
	now: number,
	timezone: string,
	days?: number,
): number {
	const cap = monthDeadline(now, timezone);
	if (days === undefined) return cap;
	if (!Number.isInteger(days) || days < 1 || days > 31)
		throw new Error("Elige entre 1 día y un mes.");
	const date = dayjs
		.utc(now)
		.tz(timezone)
		.add(days, "day")
		.format("YYYY-MM-DD HH:mm:ss");
	const result = dayjs.tz(date, timezone).valueOf();
	if (result > cap)
		throw new Error(
			"El plazo solicitado supera un mes calendario; elige menos días.",
		);
	return result;
}

export function renewalReminderAt(
	expiresAt: number,
	days: number,
	time: string,
	timezone: string,
): number {
	const date = dayjs
		.utc(expiresAt)
		.tz(timezone)
		.subtract(days, "day")
		.format("YYYY-MM-DD");
	const due = localTime(date, time, timezone);
	return Number.isFinite(due) ? due : localTime(date, "12:00", timezone);
}
