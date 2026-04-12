import { getBaseImagePath } from "./appearance.ts";
import { getDateString } from "./bot-time.ts";
import { isImageGenAvailable } from "./image/index.ts";
import type { SensoryBuffer } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

const IMAGE_EARLIEST_HOUR = 8;
const IMAGE_LATEST_HOUR = 23;

export function getTodayDate(): string {
	return getDateString();
}

export function getWeekStart(): string {
	const rdDate = getTodayDate();
	const [year, month, day] = rdDate.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ...6=Sat
	const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
	date.setDate(date.getDate() + mondayOffset);
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function generateRandomWeeklyTargetTime(): string {
	const rdDate = getTodayDate();
	const [year, month, day] = rdDate.split("-").map(Number);
	const today = new Date(year, month - 1, day);
	const todayDayOfWeek = today.getDay();

	// Days remaining in the week (Mon–Sun): Sun=0 left, Mon=6, Tue=5, ...Sat=1
	const daysLeftInWeek = todayDayOfWeek === 0 ? 0 : 7 - todayDayOfWeek;

	// Pick a random day from today through end of week
	const randomDayOffset = Math.floor(Math.random() * (daysLeftInWeek + 1));
	const targetDate = new Date(year, month - 1, day + randomDayOffset);

	const randomHour =
		IMAGE_EARLIEST_HOUR +
		Math.floor(Math.random() * (IMAGE_LATEST_HOUR - IMAGE_EARLIEST_HOUR + 1));
	const randomMinute = Math.floor(Math.random() * 60);
	targetDate.setHours(randomHour, randomMinute, 0, 0);

	return targetDate.toISOString();
}

export function shouldGenerateImageNow(buffer: SensoryBuffer): boolean {
	if (!isImageGenAvailable()) return false;
	if (!getBaseImagePath()) return false;

	const currentWeek = getWeekStart();

	// Already generated this week
	if (buffer.lastImageDate === currentWeek) return false;

	// New week or missing target — pick a random day+time this week
	if (buffer.imageTargetDate !== currentWeek || !buffer.imageTargetTime) {
		buffer.imageTargetTime = generateRandomWeeklyTargetTime();
		buffer.imageTargetDate = currentWeek;
		if (isDev) {
			console.log(
				"[image] New weekly target generated:",
				buffer.imageTargetTime,
			);
		}
	}

	// Check if current time passed target
	const now = new Date();
	const target = new Date(buffer.imageTargetTime);
	return now >= target;
}
