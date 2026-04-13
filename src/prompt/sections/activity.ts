import { botNow, getBotDay, getBotHour } from "../../bot-time.ts";
import {
	getCurrentWeatherContext,
	getDailyWeatherForImage,
} from "../../daily-weather.ts";
import { isHoliday } from "../../holidays.ts";
import type { PromptSection } from "../types.ts";

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function getTimeOfDayLabel(hour: number): string {
	if (hour < 6) return "early morning";
	if (hour < 12) return "morning";
	if (hour < 14) return "midday";
	if (hour < 18) return "afternoon";
	if (hour < 21) return "early evening";
	return "night";
}

function getActivityGuidance(): string {
	const hour = getBotHour();
	const dayOfWeek = getBotDay();
	const dayName = DAY_NAMES[dayOfWeek] ?? "Day";
	const timeLabel = getTimeOfDayLabel(hour);
	const now = botNow();
	const holiday = isHoliday(now.month(), now.date());

	const dayType = holiday
		? "holiday"
		: dayOfWeek === 0 || dayOfWeek === 6
			? "weekend"
			: "weekday";

	return `It's ${dayName} ${timeLabel} (${dayType}). Imagine what you'd be doing right now given your personality and routine, and stay consistent if you mention it. IMPORTANT: NEVER mention the day of the week or the hour explicitly in your responses (e.g., "one Sunday afternoon", "this Monday"). This information is only internal context. Talk like a real person who doesn't announce what day it is.`;
}

export const activityCurrent: PromptSection = {
	id: "activity.current",
	render() {
		return `## Your current activity\n${getActivityGuidance()}`;
	},
};

export const timeAwareness: PromptSection = {
	id: "time.awareness",
	render() {
		return `## Time awareness
Pay attention to time markers in the message history (e.g., "[~17 hours passed with no chat activity]"). When significant time has passed, acknowledge it naturally: greet according to the time of day, don't pick up the previous conversation as if it just happened, and be aware that time has passed. You don't need to mention exact hours or the day of the week — just flow naturally with the temporal context. Never say things like "one Sunday afternoon" or "this Tuesday" — a real person doesn't talk that way.`;
	},
};

export const weatherCurrent: PromptSection = {
	id: "weather.current",
	async render() {
		const weatherContext = await getCurrentWeatherContext();
		if (!weatherContext) return null;
		return `## Current weather\n${weatherContext}\n(Use this information if the user asks about the weather or if it's relevant to the conversation.)`;
	},
};

export async function getImageWeatherInstruction(): Promise<string> {
	const imageWeather = await getDailyWeatherForImage();
	if (!imageWeather) return "";
	const weatherContext = await getCurrentWeatherContext();
	return `\n\n**Current weather:** ${weatherContext}. If your scene is outdoors (beach, park, street, terrace, pool, garden, balcony, window with an outside view), incorporate this weather visually in the prompt: sky, lighting, rain if it applies, etc. Don't mention it in text, just show it. For fully interior scenes with no outside view, ignore the weather.`;
}
