import { BOT_TZ, getBotHour, getDateString } from "./bot-time.ts";
import { log } from "./logger.ts";
import { requestSignal } from "./operation-deadline.ts";
import { memoryPath } from "./runtime-paths.ts";
import { atomicWriteFile, withRetry } from "./utils.ts";
import {
	getWeatherConfig,
	weatherDescription,
	weatherService,
} from "./weather.ts";

interface DailyWeather {
	date: string; // Date in the bot timezone
	locationKey: string;
	city: string;
	period: string; // "morning" | "afternoon" | "night"
	description: string; // English: "clear and sunny"
	temperature: number;
	humidity: number;
	windSpeed: number;
	fetchedAt: number;
}

const WEATHER_FILE = memoryPath("daily-weather.json");

let cachedWeather: DailyWeather | null = null;

function getTodayDate(): string {
	return getDateString();
}

function getCurrentPeriod(): "morning" | "afternoon" | "night" {
	const hour = getBotHour();
	if (hour >= 18) return "night";
	if (hour >= 12) return "afternoon";
	return "morning";
}

function temperatureContext(temp: number): string {
	if (temp < 20) return "cool";
	if (temp <= 25) return "pleasant";
	if (temp <= 30) return "warm";
	return "hot and humid";
}

async function loadCachedWeather(): Promise<DailyWeather | null> {
	if (cachedWeather) return cachedWeather;

	try {
		const file = Bun.file(WEATHER_FILE);
		if (await file.exists()) {
			cachedWeather = (await file.json()) as DailyWeather;
			return cachedWeather;
		}
	} catch (error) {
		log.debug("[daily-weather] Error loading cache:", error);
	}
	return null;
}

async function saveWeather(weather: DailyWeather): Promise<void> {
	cachedWeather = weather;
	try {
		await atomicWriteFile(WEATHER_FILE, JSON.stringify(weather, null, 2));
		log.debug("[daily-weather] Saved to cache:", weather.date, weather.period);
	} catch (error) {
		log.error("[daily-weather] Error saving cache:", error);
	}
}

interface OpenMeteoResponse {
	current: {
		temperature_2m: number;
		relative_humidity_2m: number;
		weather_code: number;
		wind_speed_10m: number;
	};
}

async function fetchWeather(locationKey: string): Promise<DailyWeather | null> {
	try {
		const location = await weatherService.baseLocation();
		const url = new URL("https://api.open-meteo.com/v1/forecast");
		url.search = new URLSearchParams({
			latitude: String(location.latitude),
			longitude: String(location.longitude),
			current:
				"temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
			timezone: BOT_TZ,
		}).toString();

		log.debug("[daily-weather] Fetching from Open-Meteo...");
		const res = await withRetry(() =>
			fetch(url, { signal: requestSignal(10_000) }),
		);
		if (!res.ok) {
			log.error("[daily-weather] Fetch failed:", res.status);
			return null;
		}

		const data = (await res.json()) as OpenMeteoResponse;
		const current = data.current;

		const weather: DailyWeather = {
			date: getTodayDate(),
			locationKey,
			city: location.name,
			period: getCurrentPeriod(),
			description: weatherDescription(current.weather_code),
			temperature: current.temperature_2m,
			humidity: current.relative_humidity_2m,
			windSpeed: current.wind_speed_10m,
			fetchedAt: Date.now(),
		};

		await saveWeather(weather);
		log.debug(
			"[daily-weather] Fetched:",
			weather.description,
			`${weather.temperature}°C`,
			`period=${weather.period}`,
		);
		return weather;
	} catch (error) {
		log.error("[daily-weather] Error fetching weather:", error);
		return null;
	}
}

async function getWeather(): Promise<DailyWeather | null> {
	let locationKey: string;
	try {
		locationKey = JSON.stringify([getWeatherConfig(), BOT_TZ]);
	} catch {
		return null;
	}
	const today = getTodayDate();
	const period = getCurrentPeriod();
	const cached = await loadCachedWeather();

	if (
		cached &&
		cached.locationKey === locationKey &&
		cached.date === today &&
		cached.period === period
	) {
		log.debug("[daily-weather] Using cached weather:", today, period);
		return cached;
	}

	return fetchWeather(locationKey);
}

export async function getCurrentWeatherContext(): Promise<string | null> {
	const weather = await getWeather();
	if (!weather) return null;

	return `Current weather in ${weather.city}: ${weather.description}, ${Math.round(weather.temperature)}°C, ${Math.round(weather.humidity)}% humidity, wind ${Math.round(weather.windSpeed)} km/h`;
}

export async function getDailyWeatherForImage(): Promise<string | null> {
	const weather = await getWeather();
	if (!weather) return null;

	const tempContext = temperatureContext(weather.temperature);
	return `${weather.description}, ${tempContext} (${Math.round(weather.temperature)}C)`;
}
