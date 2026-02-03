import type { Content } from "@google/genai";
import { getDailyWeatherForImage } from "./daily-weather.ts";
import { isHoliday, isWeekend } from "./holidays.ts";
import { loadPermanent } from "./memory.ts";
import type {
	LongTermMemoryEntry,
	MemberMemory,
	ShortTermMemory,
} from "./types.ts";

/**
 * Get activity guidance for image generation based on time and day type
 */
function getActivityGuidance(now: Date): string {
	const hour = now.getHours();

	if (isHoliday(now)) {
		// Holiday - vacation vibes
		return "Hoy es feriado. Actividades típicas: viajando, en la playa, en la piscina, de paseo, en un resort, explorando un lugar nuevo, road trip, de vacaciones.";
	}

	if (isWeekend(now)) {
		// Weekend schedule
		if (hour < 10) {
			return "Es fin de semana por la mañana temprano. Actividades típicas: durmiendo hasta tarde, recién despertando, relajándote en casa en pijama.";
		}
		if (hour < 12) {
			return "Es fin de semana por la mañana. Actividades típicas: brunch, desayunando tarde, relajándote en casa, preparándote para salir.";
		}
		if (hour < 18) {
			return "Es fin de semana por la tarde. Actividades típicas: en el mall, en la playa, con amigas, haciendo diligencias, en el gym, en la piscina.";
		}
		if (hour < 21) {
			return "Es fin de semana por la noche temprano. Actividades típicas: en un restaurante, en un bar, arreglándote para salir, cenando.";
		}
		return "Es fin de semana de noche. Actividades típicas: en casa relajándote, viendo TV, en la cama, en un bar.";
	}

	// Workday schedule - Brendy works 9-5 at a law firm
	if (hour < 8) {
		return "Es día de trabajo temprano en la mañana. Actividades típicas: arreglándote para el trabajo, desayunando, preparándote para salir.";
	}
	if (hour < 9) {
		return "Es hora de ir al trabajo. Actividades típicas: manejando tu Hyundai Tucson en el tapón, en camino a la oficina, llegando al trabajo.";
	}
	if (hour < 12) {
		return "Estás en el trabajo (bufete de abogados). Actividades típicas: trabajando en tu escritorio, en una reunión, revisando documentos legales, tomando un café en la oficina.";
	}
	if (hour < 14) {
		return "Es hora de almuerzo en el trabajo. Actividades típicas: almorzando en la oficina, en un restaurante cerca del trabajo, descansando brevemente.";
	}
	if (hour < 17) {
		return "Estás en el trabajo por la tarde (bufete de abogados). Actividades típicas: trabajando en tu escritorio, en una reunión, revisando contratos, atendiendo clientes.";
	}
	if (hour < 18) {
		return "Estás saliendo del trabajo. Actividades típicas: manejando tu Hyundai Tucson de vuelta a casa, en el tapón, saliendo de la oficina.";
	}
	if (hour < 21) {
		return "Es día de semana después del trabajo. Actividades típicas: en el gym, en el mall, en casa relajándote, cenando, haciendo diligencias.";
	}
	return "Es día de semana de noche. Actividades típicas: en casa relajándote, viendo TV, en la cama, preparándote para dormir.";
}

export async function buildSystemPrompt(
	relevantMemories: LongTermMemoryEntry[],
	previousSummary: string,
	memberMemory: MemberMemory,
	shouldGenerateImage = false,
): Promise<string> {
	const permanent = await loadPermanent();

	const now = new Date().toLocaleString("es-DO", {
		timeZone: "America/Santo_Domingo",
		dateStyle: "full",
		timeStyle: "short",
	});
	let systemPrompt = `${permanent}\n\n## Fecha y hora actual\n${now} (hora de República Dominicana)`;

	if (relevantMemories.length > 0) {
		const memoriesText = relevantMemories
			.map((m) => `- ${m.content} (context: ${m.context})`)
			.join("\n");
		systemPrompt += `\n\n## Long-term memories\nThings you remember from past interactions:\n${memoriesText}`;
	}

	const memberNames = Object.keys(memberMemory);
	if (memberNames.length > 0) {
		let memberSection =
			"\n\n## Lo que sabes de los miembros\nEsta información es contexto interno. NO la recites ni repitas. Úsala solo cuando sea orgánicamente relevante.";
		for (const name of memberNames) {
			const facts = memberMemory[name];
			if (facts.length > 0) {
				memberSection += `\n### ${name}`;
				for (const fact of facts) {
					memberSection += `\n  - ${fact.content}`;
				}
			}
		}
		systemPrompt += memberSection;
	}

	if (previousSummary) {
		systemPrompt += `\n\n## Previous conversation context\n${previousSummary}`;
	}

	if (shouldGenerateImage) {
		const weatherContext = await getDailyWeatherForImage();
		const weatherInstruction = weatherContext
			? `\n\n**Clima actual:** ${weatherContext}. Si tu escena es al aire libre (playa, parque, calle, terraza, piscina, jardín, balcón, ventana con vista exterior), incorpora este clima visualmente en el prompt: cielo, iluminación, lluvia si aplica, etc. No lo menciones en texto, solo muéstralo. Para escenas completamente interiores sin vista al exterior, ignora el clima.`
			: "";

		const nowDR = new Date(
			new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }),
		);
		const currentTime = nowDR.toLocaleTimeString("es-DO", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		});
		const activityGuidance = getActivityGuidance(nowDR);

		systemPrompt += `\n\n## Generación de imagen
Este es tu primer mensaje del día en este chat. Incluye en tu respuesta un marcador [IMAGE: prompt artístico en inglés] describiendo una escena, ambiente o actividad que refleje tu estado de ánimo según el contexto de la interacción.${weatherInstruction}

NO incluyas descripción física tuya (se agrega automáticamente). Incluye en el prompt la ropa y el outfit que llevas en la escena. La escena debe ser coherente con la hora actual (son las ${currentTime}).

**Contexto de tu día:** ${activityGuidance}

Solo escenas de ti misma, nunca de otros. No menciones que estás generando una imagen ni pidas permiso; simplemente inclúyelo naturalmente en tu respuesta.`;
	}

	return systemPrompt;
}

export function buildContents(memory: ShortTermMemory): Content[] {
	const contents: Content[] = [];

	for (const msg of memory.messages) {
		const role = msg.role === "user" ? "user" : "model";
		const text =
			msg.role === "user" && msg.name
				? `[${msg.name}]: ${msg.content}`
				: msg.content;

		contents.push({
			role,
			parts: [{ text }],
		});
	}

	return contents;
}
