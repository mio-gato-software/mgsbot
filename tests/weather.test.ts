import { expect, test } from "bun:test";
import dayjs from "dayjs";
import {
	getWeatherConfig,
	type WeatherConfig,
	type WeatherLocation,
	WeatherService,
} from "../src/weather.ts";

const NOW = Date.parse("2026-10-23T19:30:00Z");
const santoDomingo = place("Santo Domingo", "DO", 18.48, -69.93, 2_200_000);
const santiagoDR = place(
	"Santiago de los Caballeros",
	"DO",
	19.45,
	-70.69,
	1_200_000,
);
const santiagoCL = place(
	"Santiago de Chile",
	"CL",
	-33.45,
	-70.66,
	4_800_000,
	"America/Santiago",
);
function place(
	name: string,
	country: string,
	latitude: number,
	longitude: number,
	population = 1000,
	timezone = "America/Santo_Domingo",
): WeatherLocation {
	return {
		id: latitude,
		name,
		country_code: country,
		country,
		latitude,
		longitude,
		population,
		timezone,
		feature_code: "PPL",
	};
}
function forecast(timezone: string, now: number) {
	const first = dayjs.utc(now).tz(timezone).format("YYYY-MM-DD");
	const times = Array.from({ length: 168 }, (_, i) =>
		new Date(Date.parse(`${first}T00:00:00Z`) + i * 3_600_000)
			.toISOString()
			.slice(0, 16),
	);
	return {
		timezone,
		current: {
			time: dayjs.utc(now).tz(timezone).format("YYYY-MM-DDTHH:mm"),
			temperature_2m: 28,
			relative_humidity_2m: 75,
			weather_code: 61,
			wind_speed_10m: 12,
		},
		hourly: {
			time: times,
			temperature_2m: times.map(() => 27 as number | null),
			precipitation_probability: times.map(() => 60 as number | null),
			precipitation: times.map(() => 1 as number | null),
			weather_code: times.map(() => 61 as number | null),
			wind_speed_10m: times.map(() => 15 as number | null),
		},
	};
}
function harness(
	options: {
		config?: WeatherConfig;
		places?: WeatherLocation[];
		now?: number;
		data?: (data: ReturnType<typeof forecast>) => unknown;
		failure?: "geocode" | "forecast";
	} = {},
) {
	let now = options.now ?? NOW;
	const requests: URL[] = [];
	const places = options.places ?? [santoDomingo, santiagoDR, santiagoCL];
	const service = new WeatherService({
		enabled: () => true,
		now: () => now,
		config: () =>
			options.config ?? {
				city: "Santo Domingo",
				latitude: 18.48,
				longitude: -69.93,
			},
		fetch: (async (input: URL) => {
			const url = new URL(input);
			requests.push(url);
			if (url.hostname === "geocoding-api.open-meteo.com") {
				if (options.failure === "geocode")
					return new Response("unavailable", { status: 503 });
				const name =
					url.searchParams.get("name")?.split(",")[0]?.toLowerCase() ?? "";
				const country =
					url.searchParams.get("countryCode") ??
					(url.searchParams.get("name")?.includes(", Chile")
						? "CL"
						: undefined);
				return Response.json({
					results: places.filter(
						(location) =>
							location.name.toLowerCase().startsWith(name) &&
							(!country || location.country_code === country),
					),
				});
			}
			expect(url.hostname).toBe("api.open-meteo.com");
			expect(url.searchParams.get("timezone")).toBe("auto");
			expect(url.searchParams.get("forecast_days")).toBe("7");
			if (options.failure === "forecast")
				return new Response("unavailable", { status: 503 });
			const location = places.find(
				(item) => String(item.latitude) === url.searchParams.get("latitude"),
			);
			const data = forecast(location?.timezone ?? "America/Santo_Domingo", now);
			return Response.json(options.data ? options.data(data) : data);
		}) as typeof fetch,
	});
	return {
		service,
		requests,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("base configuration preserves defaults, supports city-only installations and rejects partial coordinates", () => {
	const keys = [
		"WEATHER_CITY",
		"WEATHER_COUNTRY",
		"WEATHER_LATITUDE",
		"WEATHER_LONGITUDE",
	];
	const saved = keys.map((key) => process.env[key]);
	try {
		for (const key of keys) delete process.env[key];
		expect(getWeatherConfig()).toEqual({
			city: "Santo Domingo",
			latitude: 18.4861,
			longitude: -69.9312,
			countryCode: undefined,
		});
		process.env.WEATHER_CITY = "Santiago, Chile";
		expect(getWeatherConfig().latitude).toBeUndefined();
		process.env.WEATHER_COUNTRY = " cl ";
		expect(getWeatherConfig().countryCode).toBe("CL");
		process.env.WEATHER_LATITUDE = "-33.45";
		expect(() => getWeatherConfig()).toThrow("both");
		process.env.WEATHER_LONGITUDE = "-70.66";
		expect(getWeatherConfig().latitude).toBe(-33.45);
		process.env.WEATHER_LATITUDE = "91";
		expect(() => getWeatherConfig()).toThrow("Invalid");
		process.env.WEATHER_LATITUDE = "abc";
		expect(() => getWeatherConfig()).toThrow("Invalid");
		process.env.WEATHER_COUNTRY = "Chile";
		expect(() => getWeatherConfig()).toThrow("two-letter");
	} finally {
		keys.forEach((key, i) => {
			if (saved[i] === undefined) delete process.env[key];
			else process.env[key] = saved[i];
		});
	}
});

test("Santiago follows the reference country inferred from coordinates, without a hardcoded country", async () => {
	const { service, requests } = harness();
	const result = JSON.parse(
		await service.lookup({
			location: "Santiago",
			period: "night",
			notice: "Miro",
		}),
	);
	const query = requests.find(
		(url) => url.searchParams.get("name") === "Santiago",
	);
	const forecastRequest = requests.find(
		(url) => url.hostname === "api.open-meteo.com",
	);
	// Inspect the request too: a failure swallowed by lookup must not hide a broken filter.
	expect(query?.searchParams.get("countryCode")).toBe("DO");
	expect(forecastRequest?.searchParams.get("latitude")).toBe(
		String(santiagoDR.latitude),
	);
	expect(result.status).toBe("ok");
	expect(result.location.name).toBe("Santiago de los Caballeros");
	expect(result.hours.map((row: { time: string }) => row.time)).toEqual(
		Array.from({ length: 6 }, (_, i) => `2026-10-23T${18 + i}:00`),
	);
	expect(result.hours[0]).toMatchObject({
		temperature: 27,
		rainProbability: 60,
		description: "light rain",
		wind: 15,
	});
});

test("a Chilean installation resolves Santiago locally and a stated country overrides the reference", async () => {
	const { service, requests } = harness({
		config: { city: "Santiago, Chile" },
	});
	const local = JSON.parse(
		await service.lookup({ location: "Santiago", notice: "Miro" }),
	);
	expect(local.status).toBe("ok");
	expect(local.location.country_code).toBe("CL");
	expect(
		requests.some((url) => url.searchParams.get("countryCode") === "DO"),
	).toBe(false);
	const abroad = JSON.parse(
		await service.lookup({
			location: "Santiago",
			countryCode: "DO",
			period: "current",
			notice: "Miro",
		}),
	);
	expect(abroad.location.country_code).toBe("DO");
	expect(abroad.current.temperature_2m).toBe(28);
	expect(abroad.hours).toBeUndefined();
});

test("an explicit country qualifier bypasses the regional preference", async () => {
	const { service, requests } = harness();
	const result = JSON.parse(
		await service.lookup({ location: "Santiago, Chile", notice: "Miro" }),
	);
	expect(result.location.country_code).toBe("CL");
	expect(requests[0]?.searchParams.get("name")).toBe("Santiago, Chile");
	expect(requests[0]?.searchParams.has("countryCode")).toBe(false);
});

test("a missing local match falls back globally; unresolved ambiguity asks instead of forecasting", async () => {
	const paris = place("Paris", "FR", 48.8, 2.3, 2_000_000, "Europe/Paris");
	const local = harness({ places: [santoDomingo, paris] });
	const result = JSON.parse(
		await local.service.lookup({ location: "Paris", notice: "Miro" }),
	);
	expect(result.location.country_code).toBe("FR");
	expect(
		local.requests
			.filter((url) => url.searchParams.get("name") === "Paris")
			.map((url) => url.searchParams.get("countryCode")),
	).toEqual(["DO", null]);
	const ambiguous = harness({
		config: { city: "Home", countryCode: "DO" },
		places: [
			place("San José Uno", "DO", 19, -70, 40_000),
			place("San José Dos", "DO", 18, -70, 30_000),
		],
	});
	const unclear = JSON.parse(
		await ambiguous.service.lookup({ location: "San José", notice: "Miro" }),
	);
	expect(unclear.status).toBe("ambiguous");
	expect(unclear.candidates).toHaveLength(2);
	expect(ambiguous.requests).toHaveLength(1);
	const absent = JSON.parse(
		await ambiguous.service.lookup({ location: "Unknown", notice: "Miro" }),
	);
	expect(absent.status).toBe("not_found");
});

test("only a clearly dominant city wins over small similarly named places", async () => {
	const small = place("Santiago de La Cruz", "DO", 19.5, -71.6, 16_000);
	const { service } = harness({ places: [santoDomingo, santiagoDR, small] });
	const result = JSON.parse(
		await service.lookup({ location: "Santiago", notice: "Miro" }),
	);
	expect(result.location.name).toBe(santiagoDR.name);
});

test("relative dates use destination time across midnight, and exact hours and seven-day bounds are enforced", async () => {
	const auckland = place(
		"Auckland",
		"NZ",
		-36.85,
		174.76,
		1_000_000,
		"Pacific/Auckland",
	);
	const { service } = harness({
		places: [auckland],
		now: Date.parse("2026-10-23T23:30:00Z"),
	});
	const request = { location: "Auckland", countryCode: "NZ", notice: "Miro" };
	const tomorrow = JSON.parse(
		await service.lookup({ ...request, dayOffset: 1, hour: 8 }),
	);
	expect(tomorrow.date).toBe("2026-10-25");
	expect(tomorrow.hours).toHaveLength(1);
	expect(tomorrow.hours[0].time).toBe("2026-10-25T08:00");
	const last = JSON.parse(
		await service.lookup({ ...request, dayOffset: 6, period: "night" }),
	);
	expect(last.status).toBe("ok");
	expect(last.date).toBe("2026-10-30");
	for (const date of ["2026-10-23", "2026-10-31"]) {
		expect(JSON.parse(await service.lookup({ ...request, date })).status).toBe(
			"out_of_range",
		);
	}
	const elapsed = JSON.parse(
		await service.lookup({ ...request, period: "morning" }),
	);
	expect(elapsed.status).toBe("unavailable");
	expect(elapsed.hours).toHaveLength(0);
});

test("coordinate-only installations use the forecast timezone, not BOT_TIMEZONE", async () => {
	const { service } = harness({
		config: {
			city: "Configured location",
			latitude: santiagoCL.latitude,
			longitude: santiagoCL.longitude,
		},
	});
	const result = JSON.parse(
		await service.lookup({ period: "current", notice: "Miro" }),
	);
	expect(result.status).toBe("ok");
	expect(result.timezone).toBe("America/Santiago");
});

test("geocodes and forecasts have separate expiry; yesterday's cache cannot shorten today's horizon", async () => {
	const { service, requests, advance } = harness();
	const request = { location: "Santiago", notice: "Miro" };
	const first = JSON.parse(await service.lookup(request));
	advance(60_000);
	const second = JSON.parse(await service.lookup(request));
	expect(second.checkedAt).toBe(first.checkedAt);
	expect(requests).toHaveLength(3);
	advance(900_000);
	const third = JSON.parse(await service.lookup(request));
	expect(third.checkedAt).not.toBe(first.checkedAt);
	expect(requests).toHaveLength(4);
	advance(86_400_000);
	await service.lookup(request);
	expect(requests).toHaveLength(7);
	const midnight = harness({ now: Date.parse("2026-10-24T03:58:00Z") });
	await midnight.service.lookup(request);
	midnight.advance(180_000);
	expect(
		JSON.parse(await midnight.service.lookup({ ...request, dayOffset: 6 }))
			.status,
	).toBe("ok");
	expect(
		midnight.requests.filter((url) => url.hostname === "api.open-meteo.com"),
	).toHaveLength(2);
});

test("null weather data stays unknown; malformed responses and outages never become forecasts", async () => {
	const missing = harness({
		data: (data) => {
			data.hourly.precipitation_probability.fill(null);
			return data;
		},
	});
	const result = JSON.parse(
		await missing.service.lookup({ location: "Santiago", notice: "Miro" }),
	);
	expect(result.status).toBe("ok");
	expect(result.hours[0].rainProbability).toBeNull();
	for (const failure of ["geocode", "forecast"] as const) {
		const { service } = harness({ failure });
		const unavailable = JSON.parse(
			await service.lookup({
				location: "Santiago",
				countryCode: "DO",
				notice: "Miro",
			}),
		);
		expect(unavailable.status).toBe("unavailable");
		expect(unavailable.hours).toBeUndefined();
	}
	const malformed = harness({
		data: (data) => {
			data.hourly.temperature_2m.pop();
			return data;
		},
	});
	expect(
		JSON.parse(
			await malformed.service.lookup({ location: "Santiago", notice: "Miro" }),
		).status,
	).toBe("unavailable");
});

test("invalid dates, conflicting parameters and foreign fields perform no requests", async () => {
	const { service, requests } = harness();
	for (const parameters of [
		{ date: "2026-02-30" },
		{ date: "2026-10-23", dayOffset: 1 },
		{ dayOffset: 7 },
		{ hour: 24 },
		{ period: "current", dayOffset: 1 },
		{ countryCode: "DO" },
		{ url: "http://localhost" },
	]) {
		expect(
			JSON.parse(
				await service.lookup({ notice: "Miro", ...parameters } as never),
			).status,
		).toBe("unavailable");
	}
	expect(requests).toHaveLength(0);
});
