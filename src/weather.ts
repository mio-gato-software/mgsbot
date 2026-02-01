import type { FunctionDeclaration } from "@google/genai";

const WMO_DESCRIPTIONS: Record<number, string> = {
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

function weatherCodeToDescription(code: number): string {
	return WMO_DESCRIPTIONS[code] ?? "Desconocido";
}

export const weatherTool: FunctionDeclaration = {
	name: "get_current_weather",
	description:
		"Obtiene el clima actual en Santo Domingo, República Dominicana. Incluye temperatura, humedad, viento y condición climática. Usa esta función cuando: el usuario pregunte por el clima, temperatura o condiciones; alguien esté planeando una salida, paseo, evento al aire libre o actividad; se discuta si salir o quedarse en casa; cualquier situación donde el clima sea relevante para la conversación.",
	parameters: {
		type: "object",
		properties: {},
	},
};

interface OpenMeteoResponse {
	current: {
		temperature_2m: number;
		relative_humidity_2m: number;
		weather_code: number;
		wind_speed_10m: number;
	};
}

export async function executeWeatherFunction(): Promise<string> {
	try {
		const url =
			"https://api.open-meteo.com/v1/forecast?latitude=18.4861&longitude=-69.9312&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=America/Santo_Domingo";

		const res = await fetch(url);
		if (!res.ok) {
			return JSON.stringify({ error: "No se pudo obtener el clima" });
		}

		const data = (await res.json()) as OpenMeteoResponse;
		const current = data.current;

		return JSON.stringify({
			ubicacion: "Santo Domingo, República Dominicana",
			temperatura: `${current.temperature_2m}°C`,
			humedad: `${current.relative_humidity_2m}%`,
			viento: `${current.wind_speed_10m} km/h`,
			condicion: weatherCodeToDescription(current.weather_code),
		});
	} catch (error) {
		console.error("[weather] Error fetching weather:", error);
		return JSON.stringify({ error: "No se pudo obtener el clima" });
	}
}
