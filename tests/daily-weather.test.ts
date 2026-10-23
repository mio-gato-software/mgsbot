import { expect, spyOn, test } from "bun:test";
import { getCurrentWeatherContext } from "../src/daily-weather.ts";
import { weatherService } from "../src/weather.ts";

test("ambient weather uses resolved coordinates and a location change invalidates the cached city", async () => {
	const keys = [
		"WEATHER_CITY",
		"WEATHER_COUNTRY",
		"WEATHER_LATITUDE",
		"WEATHER_LONGITUDE",
	];
	const saved = keys.map((key) => process.env[key]);
	const originalFetch = globalThis.fetch;
	let reads = 0;
	const base = spyOn(weatherService, "baseLocation").mockImplementation(
		async () => ({
			name: process.env.WEATHER_CITY ?? "",
			latitude: -33.45,
			longitude: -70.66,
			country_code: "CL",
			timezone: "America/Santiago",
		}),
	);
	try {
		for (const key of keys) delete process.env[key];
		process.env.WEATHER_CITY = "Santiago, Chile";
		process.env.WEATHER_COUNTRY = "CL";
		globalThis.fetch = (async (input: URL) => {
			reads++;
			const url = new URL(input);
			expect(url.searchParams.get("latitude")).toBe("-33.45");
			expect(url.searchParams.get("longitude")).toBe("-70.66");
			return Response.json({
				current: {
					temperature_2m: 20,
					relative_humidity_2m: 60,
					weather_code: 0,
					wind_speed_10m: 10,
				},
			});
		}) as typeof fetch;
		expect(await getCurrentWeatherContext()).toContain("Santiago, Chile");
		expect(await getCurrentWeatherContext()).toContain("20°C");
		expect(reads).toBe(1);
		process.env.WEATHER_CITY = "Another configured city";
		expect(await getCurrentWeatherContext()).toContain(
			"Another configured city",
		);
		expect(reads).toBe(2);
		process.env.WEATHER_LATITUDE = "5";
		expect(await getCurrentWeatherContext()).toBeNull();
		expect(reads).toBe(2);
	} finally {
		base.mockRestore();
		globalThis.fetch = originalFetch;
		keys.forEach((key, i) => {
			if (saved[i] === undefined) delete process.env[key];
			else process.env[key] = saved[i];
		});
	}
});
