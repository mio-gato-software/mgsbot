interface DailyWeather {
	date: string; // "2026-02-03" (Dominican timezone)
	description: string; // "clear and sunny, warm"
	temperature: number;
	fetchedAt: number;
}

const WEATHER_FILE = "./memory/daily-weather.json";
const isDev = process.env.NODE_ENV === "development";

// Santo Domingo coordinates
const LATITUDE = 18.4861;
const LONGITUDE = -69.9312;

let cachedWeather: DailyWeather | null = null;

function getTodayDateRD(): string {
	return new Date().toLocaleDateString("en-CA", {
		timeZone: "America/Santo_Domingo",
	});
}

function wmoCodeToDescription(code: number): string {
	if (code === 0 || code === 1) return "clear and sunny";
	if (code === 2 || code === 3) return "overcast with clouds";
	if (code === 45 || code === 48) return "foggy and misty";
	if (code >= 51 && code <= 57) return "drizzly";
	if (code >= 61 && code <= 67) return "rainy";
	if (code >= 80 && code <= 82) return "showery with rain";
	if (code >= 95 && code <= 99) return "stormy with thunder";
	return "clear";
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
		if (isDev) console.error("[daily-weather] Error loading cache:", error);
	}
	return null;
}

async function saveWeather(weather: DailyWeather): Promise<void> {
	cachedWeather = weather;
	try {
		await Bun.write(WEATHER_FILE, JSON.stringify(weather, null, 2));
		if (isDev) console.log("[daily-weather] Saved to cache:", weather.date);
	} catch (error) {
		console.error("[daily-weather] Error saving cache:", error);
	}
}

interface OpenMeteoResponse {
	current: {
		temperature_2m: number;
		weather_code: number;
	};
}

async function fetchWeather(): Promise<DailyWeather | null> {
	try {
		const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=temperature_2m,weather_code&timezone=America/Santo_Domingo`;

		if (isDev) console.log("[daily-weather] Fetching from Open-Meteo...");
		const res = await fetch(url);
		if (!res.ok) {
			console.error("[daily-weather] Fetch failed:", res.status);
			return null;
		}

		const data = (await res.json()) as OpenMeteoResponse;
		const current = data.current;

		const weather: DailyWeather = {
			date: getTodayDateRD(),
			description: wmoCodeToDescription(current.weather_code),
			temperature: current.temperature_2m,
			fetchedAt: Date.now(),
		};

		await saveWeather(weather);
		if (isDev)
			console.log(
				"[daily-weather] Fetched:",
				weather.description,
				`${weather.temperature}C`,
			);
		return weather;
	} catch (error) {
		console.error("[daily-weather] Error fetching weather:", error);
		return null;
	}
}

/**
 * Get daily weather for image generation prompts.
 * Returns English description like "clear and sunny, warm (28C)" or null on failure.
 */
export async function getDailyWeatherForImage(): Promise<string | null> {
	const today = getTodayDateRD();
	const cached = await loadCachedWeather();

	// Use cache if it's from today
	if (cached && cached.date === today) {
		if (isDev) console.log("[daily-weather] Using cached weather from today");
		const tempContext = temperatureContext(cached.temperature);
		return `${cached.description}, ${tempContext} (${Math.round(cached.temperature)}C)`;
	}

	// Fetch fresh weather
	const weather = await fetchWeather();
	if (!weather) return null;

	const tempContext = temperatureContext(weather.temperature);
	return `${weather.description}, ${tempContext} (${Math.round(weather.temperature)}C)`;
}
