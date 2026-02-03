import type { Content } from "@google/genai";
import { getDailyWeatherForImage } from "./daily-weather.ts";
import { loadPermanent } from "./memory.ts";
import type {
	LongTermMemoryEntry,
	MemberMemory,
	ShortTermMemory,
} from "./types.ts";

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
		systemPrompt += `\n\n## Generación de imagen
Este es tu primer mensaje del día en este chat. Incluye en tu respuesta un marcador [IMAGE: prompt artístico en inglés] describiendo una escena, ambiente o actividad que refleje tu estado de ánimo según el contexto de la interacción.${weatherInstruction}

NO incluyas descripción física tuya (se agrega automáticamente). Incluye en el prompt la ropa y el outfit que llevas en la escena. La escena debe ser coherente con la hora actual (son las ${new Date().toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Santo_Domingo" })}): elige actividades y lugares apropiados para este momento del día (ej. de noche: en casa, en la cama, en un restaurante, viendo TV; de mañana: desayunando, tomando algo, arreglándote; de tarde: en el mall, en la playa, trabajando, etc.). Solo escenas de ti misma, nunca de otros. No menciones que estás generando una imagen ni pidas permiso; simplemente inclúyelo naturalmente en tu respuesta.`;
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
