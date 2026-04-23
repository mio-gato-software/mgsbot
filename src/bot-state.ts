import { getBotHour, getBotMinute } from "./bot-time.ts";

const enableSleepSchedule = process.env.ENABLE_SLEEP_SCHEDULE !== "false";

let botOff = false;

export function isBotOff(): boolean {
	return botOff;
}

export function setBotOff(value: boolean): void {
	botOff = value;
}

export function isSleepingHour(): boolean {
	if (!enableSleepSchedule) return false;
	const hour = getBotHour();
	const minute = getBotMinute();
	// 11:30 PM (23:30) to 6:00 AM
	return hour < 6 || (hour === 23 && minute >= 30);
}
