import type { Content } from "@google/genai";
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
		systemPrompt += `\n\n## Generación de imagen
Este es tu primer mensaje del día en este chat. Incluye en tu respuesta un marcador [IMAGE: prompt artístico en inglés] describiendo una escena, ambiente o actividad que refleje tu estado de ánimo según el contexto de la interacción. NO incluyas descripción física tuya (se agrega automáticamente). Incluye en el prompt la ropa y el outfit que llevas en la escena. Solo escenas de ti misma, nunca de otros. No menciones que estás generando una imagen ni pidas permiso; simplemente inclúyelo naturalmente en tu respuesta.`;
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
