import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const BOT_TZ = process.env.BOT_TIMEZONE || "America/Santo_Domingo";

/**
 * Get current bot-timezone time as a dayjs instance.
 * Optionally pass a Date/timestamp to convert.
 */
export function botNow(date?: Date | number): dayjs.Dayjs {
	return dayjs.utc(date).tz(BOT_TZ);
}

/**
 * Format current date/time in English for the system prompt.
 * Example: "Sunday, March 1, 2026, 9:48 a.m."
 */
export function formatDateTime(date?: Date | number): string {
	const d = botNow(date);

	const days = [
		"Sunday",
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
	];
	const months = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];

	const dayName = days[d.day()];
	const dayNum = d.date();
	const monthName = months[d.month()];
	const year = d.year();
	const hour = d.hour();
	const minute = d.minute();

	const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
	const ampm = hour < 12 ? "a.m." : "p.m.";
	const minuteStr = String(minute).padStart(2, "0");

	return `${dayName}, ${monthName} ${dayNum}, ${year}, ${h12}:${minuteStr} ${ampm}`;
}

/**
 * Get current date as YYYY-MM-DD string in bot timezone.
 */
export function getDateString(date?: Date | number): string {
	return botNow(date).format("YYYY-MM-DD");
}

/**
 * Get the current hour in bot timezone (0-23).
 */
export function getBotHour(date?: Date | number): number {
	return botNow(date).hour();
}

/**
 * Get the current minute in bot timezone (0-59).
 */
export function getBotMinute(date?: Date | number): number {
	return botNow(date).minute();
}

/**
 * Get the current day of week in bot timezone (0=Sunday, 6=Saturday).
 */
export function getBotDay(date?: Date | number): number {
	return botNow(date).day();
}

/**
 * Format bot-timezone time as "h:mm a.m./p.m." string.
 * Example: "9:48 a.m."
 */
export function formatTime(date?: Date | number): string {
	const d = botNow(date);
	const hour = d.hour();
	const minute = d.minute();
	const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
	const ampm = hour < 12 ? "a.m." : "p.m.";
	return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}
