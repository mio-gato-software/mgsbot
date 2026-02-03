/**
 * Dominican Republic holidays for 2026
 * Dates are adjusted according to Ley 139-97 (movable holidays)
 */

// Format: [month (0-indexed), day]
const HOLIDAYS_2026: [number, number][] = [
	[0, 1], // New Year's Day
	[0, 5], // Santos Reyes (moved from Jan 6)
	[0, 21], // Nuestra Señora de la Altagracia
	[0, 26], // Duarte's birthday
	[1, 27], // Independence Day
	[3, 3], // Good Friday
	[4, 4], // Labor Day (moved from May 1)
	[5, 4], // Corpus Christi
	[7, 16], // Restoration Day
	[8, 24], // Nuestra Señora de las Mercedes
	[10, 9], // Constitution Day (moved from Nov 6)
	[11, 25], // Christmas
];

/**
 * Check if a date is a Dominican Republic holiday
 */
export function isHoliday(date: Date): boolean {
	const month = date.getMonth();
	const day = date.getDate();

	return HOLIDAYS_2026.some(([m, d]) => m === month && d === day);
}

/**
 * Check if a date is a workday (not weekend, not holiday)
 */
export function isWorkday(date: Date): boolean {
	const dayOfWeek = date.getDay();
	const isWeekend = dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday

	return !isWeekend && !isHoliday(date);
}

/**
 * Check if a date is a weekend
 */
export function isWeekend(date: Date): boolean {
	const dayOfWeek = date.getDay();
	return dayOfWeek === 0 || dayOfWeek === 6;
}
