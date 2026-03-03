import { BOT_TZ, getBotHour, getDateString } from "./bot-time.ts";

interface DailyWeather {
	date: string; // "2026-02-03" (Dominican timezone)
	period: string; // "morning" | "afternoon" | "night"
	description: string; // Spanish: "Despejado"
	temperature: number;
	humidity: number;
	windSpeed: number;
	fetchedAt: number;
}

const WEATHER_FILE = "./memory/daily-weather.json";
const isDev = process.env.NODE_ENV === "development";

// Santo Domingo coordinates
const LATITUDE = 18.4861;
const LONGITUDE = -69.9312;

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

const WMO_DESCRIPTIONS_ES: Record<number, string> = {
	0: "Despejado",
	1: "Mayormente despejado",
	2: "Parcialmente nublado",
	3: "Nublado",
	45: "Niebla",
	48: "Niebla con escarcha",
	51: "Llovizna ligera",
	53: "Llovizna moderada",
	55: "Llovizna intensa",
	56: "Llovizna helada ligera",
	57: "Llovizna helada intensa",
	61: "Lluvia ligera",
	63: "Lluvia moderada",
	65: "Lluvia intensa",
	66: "Lluvia helada ligera",
	67: "Lluvia helada intensa",
	71: "Nieve ligera",
	73: "Nieve moderada",
	75: "Nieve intensa",
	77: "Granizo fino",
	80: "Chubascos ligeros",
	81: "Chubascos moderados",
	82: "Chubascos intensos",
	85: "Chubascos de nieve ligeros",
	86: "Chubascos de nieve intensos",
	95: "Tormenta eléctrica",
	96: "Tormenta con granizo ligero",
	99: "Tormenta con granizo intenso",
};

const WMO_DESCRIPTIONS_EN: Record<number, string> = {
	0: "clear and sunny",
	1: "mostly clear",
	2: "partly cloudy",
	3: "overcast",
	45: "foggy",
	48: "foggy with frost",
	51: "light drizzle",
	53: "moderate drizzle",
	55: "heavy drizzle",
	56: "light freezing drizzle",
	57: "heavy freezing drizzle",
	61: "light rain",
	63: "moderate rain",
	65: "heavy rain",
	66: "light freezing rain",
	67: "heavy freezing rain",
	71: "light snow",
	73: "moderate snow",
	75: "heavy snow",
	77: "fine hail",
	80: "light showers",
	81: "moderate showers",
	82: "heavy showers",
	85: "light snow showers",
	86: "heavy snow showers",
	95: "thunderstorm",
	96: "thunderstorm with light hail",
	99: "thunderstorm with heavy hail",
};

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
		if (isDev) console.error("[daily-weather] Error loading cache:", error);
	}
	return null;
}

async function saveWeather(weather: DailyWeather): Promise<void> {
	cachedWeather = weather;
	try {
		await Bun.write(WEATHER_FILE, JSON.stringify(weather, null, 2));
		if (isDev)
			console.log(
				"[daily-weather] Saved to cache:",
				weather.date,
				weather.period,
			);
	} catch (error) {
		console.error("[daily-weather] Error saving cache:", error);
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

async function fetchWeather(): Promise<DailyWeather | null> {
	try {
		const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=${BOT_TZ}`;

		if (isDev) console.log("[daily-weather] Fetching from Open-Meteo...");
		const res = await fetch(url);
		if (!res.ok) {
			console.error("[daily-weather] Fetch failed:", res.status);
			return null;
		}

		const data = (await res.json()) as OpenMeteoResponse;
		const current = data.current;

		const weather: DailyWeather = {
			date: getTodayDate(),
			period: getCurrentPeriod(),
			description: WMO_DESCRIPTIONS_ES[current.weather_code] ?? "Desconocido",
			temperature: current.temperature_2m,
			humidity: current.relative_humidity_2m,
			windSpeed: current.wind_speed_10m,
			fetchedAt: Date.now(),
		};

		await saveWeather(weather);
		if (isDev)
			console.log(
				"[daily-weather] Fetched:",
				weather.description,
				`${weather.temperature}°C`,
				`period=${weather.period}`,
			);
		return weather;
	} catch (error) {
		console.error("[daily-weather] Error fetching weather:", error);
		return null;
	}
}

async function getWeather(): Promise<DailyWeather | null> {
	const today = getTodayDate();
	const period = getCurrentPeriod();
	const cached = await loadCachedWeather();

	if (cached && cached.date === today && cached.period === period) {
		if (isDev)
			console.log("[daily-weather] Using cached weather:", today, period);
		return cached;
	}

	return fetchWeather();
}

/**
 * Get current weather context in Spanish for system prompt injection.
 * Returns a string like "Clima actual en Santo Domingo: Despejado, 28°C, humedad 65%, viento 12 km/h"
 * or null on failure.
 */
export async function getCurrentWeatherContext(): Promise<string | null> {
	const weather = await getWeather();
	if (!weather) return null;

	return `Clima actual en Santo Domingo: ${weather.description}, ${Math.round(weather.temperature)}°C, humedad ${Math.round(weather.humidity)}%, viento ${Math.round(weather.windSpeed)} km/h`;
}

/**
 * Get daily weather for image generation prompts.
 * Returns English description like "clear and sunny, warm (28C)" or null on failure.
 */
export async function getDailyWeatherForImage(): Promise<string | null> {
	const weather = await getWeather();
	if (!weather) return null;

	// Find English description from the weather code
	// We need to reverse-lookup the code from the Spanish description
	const code = Number(
		Object.entries(WMO_DESCRIPTIONS_ES).find(
			([, desc]) => desc === weather.description,
		)?.[0],
	);
	const englishDesc = WMO_DESCRIPTIONS_EN[code] ?? "clear";
	const tempContext = temperatureContext(weather.temperature);
	return `${englishDesc}, ${tempContext} (${Math.round(weather.temperature)}C)`;
}
