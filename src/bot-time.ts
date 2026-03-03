import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const DR_TZ = process.env.BOT_TIMEZONE || "America/Santo_Domingo";

/**
 * Get current DR time as a dayjs instance.
 * Optionally pass a Date/timestamp to convert to DR time.
 */
export function drNow(date?: Date | number): dayjs.Dayjs {
	return dayjs(date).tz(DR_TZ);
}

/**
 * Format current DR date/time in Spanish for the system prompt.
 * Example: "domingo, 1 de marzo de 2026, 9:48 a.m."
 */
export function formatDRDateTime(date?: Date | number): string {
	const d = drNow(date);

	const days = [
		"domingo",
		"lunes",
		"martes",
		"miércoles",
		"jueves",
		"viernes",
		"sábado",
	];
	const months = [
		"enero",
		"febrero",
		"marzo",
		"abril",
		"mayo",
		"junio",
		"julio",
		"agosto",
		"septiembre",
		"octubre",
		"noviembre",
		"diciembre",
	];

	const dayName = days[d.day()];
	const dayNum = d.date();
	const monthName = months[d.month()];
	const year = d.year();
	const hour = d.hour();
	const minute = d.minute();

	const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
	const ampm = hour < 12 ? "a.\u00a0m." : "p.\u00a0m.";
	const minuteStr = String(minute).padStart(2, "0");

	return `${dayName}, ${dayNum} de ${monthName} de ${year}, ${h12}:${minuteStr} ${ampm}`;
}

/**
 * Get current DR date as YYYY-MM-DD string.
 */
export function getDRDateString(date?: Date | number): string {
	return drNow(date).format("YYYY-MM-DD");
}

/**
 * Get the current hour in DR timezone (0-23).
 */
export function getDRHour(date?: Date | number): number {
	return drNow(date).hour();
}

/**
 * Get the current minute in DR timezone (0-59).
 */
export function getDRMinute(date?: Date | number): number {
	return drNow(date).minute();
}

/**
 * Get the current day of week in DR timezone (0=Sunday, 6=Saturday).
 */
export function getDRDay(date?: Date | number): number {
	return drNow(date).day();
}

/**
 * Format DR time as "h:mm a.m./p.m." string.
 * Example: "9:48 a.m."
 */
export function formatDRTime(date?: Date | number): string {
	const d = drNow(date);
	const hour = d.hour();
	const minute = d.minute();
	const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
	const ampm = hour < 12 ? "a.\u00a0m." : "p.\u00a0m.";
	return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}
