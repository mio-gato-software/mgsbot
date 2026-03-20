/**
 * Holiday calendar — customize this for your country/region.
 *
 * Each entry maps a year to an array of [month (0-indexed), day] tuples.
 * The bot uses this to add holiday context to conversations.
 *
 * The default below is Dominican Republic (adjusted per Ley 139-97 movable holidays).
 * Update or replace these entries for your own locale.
 * If the current year has no entry, isHoliday() returns false (no crash).
 */

// Format: [month (0-indexed), day]
const HOLIDAYS: Record<number, [number, number][]> = {
	2026: [
		[0, 1], // New Year's Day
		[0, 5], // Santos Reyes (moved from Jan 6)
		[0, 21], // Nuestra Señora de la Altagracia
		[0, 26], // Duarte's birthday (moved from Jan 26)
		[1, 27], // Independence Day
		[3, 3], // Good Friday
		[4, 4], // Labor Day (moved from May 1)
		[5, 4], // Corpus Christi
		[7, 16], // Restoration Day
		[8, 24], // Nuestra Señora de las Mercedes
		[10, 9], // Constitution Day (moved from Nov 6)
		[11, 25], // Christmas
	],
};

/**
 * Check if a date is a holiday in the configured calendar.
 * @param month 0-indexed month (0=January)
 * @param day Day of the month
 * @param year Full year (defaults to current year)
 */
export function isHoliday(
	month: number,
	day: number,
	year = new Date().getFullYear(),
): boolean {
	const yearHolidays = HOLIDAYS[year];
	if (!yearHolidays) return false;
	return yearHolidays.some(([m, d]) => m === month && d === day);
}
