import type { Content } from "@google/genai";
import { getDailyWeatherForImage } from "./daily-weather.ts";
import type { MentionType } from "./handlers.ts";
import { isHoliday } from "./holidays.ts";
import { loadPermanent } from "./memory.ts";
import type { ChatMessage } from "./providers/types.ts";
import type {
	LongTermMemoryEntry,
	MemberMemory,
	ShortTermMemory,
} from "./types.ts";

export const isSimpleAssistantMode =
	process.env.SIMPLE_ASSISTANT_MODE === "true";

const SIMPLE_ASSISTANT_PROMPT = `You are a helpful assistant. Respond clearly and concisely to user questions.`;

/**
 * Determine if it's a "busy" time when Brendy might decline to chat extensively
 * Returns a guidance string if busy, null if available
 * NOTE: Disabled - Brendy now always has time to chat while maintaining her routine
 */
function getBusyGuidance(_now: Date): string | null {
	return null;
}

/**
 * Get activity guidance for image generation based on time and day type
 */
function getActivityGuidance(now: Date): string {
	const hour = now.getHours();
	const dayOfWeek = now.getDay();

	if (isHoliday(now)) {
		return "Hoy es feriado. Actividades: viajando, en la playa, piscina, de paseo, road trip.";
	}

	// Saturday
	if (dayOfWeek === 6) {
		if (hour < 10) return "Sábado temprano: durmiendo hasta tarde, en pijama.";
		if (hour < 13)
			return "Sábado mañana: self-care, salón de uñas, peluquería.";
		if (hour < 18) return "Sábado tarde: en el mall, en la playa, con amigas.";
		if (hour < 21)
			return "Sábado noche temprano: en un restaurante, arreglándote para salir.";
		return "Sábado noche: en casa relajándote o en un bar.";
	}

	// Sunday
	if (dayOfWeek === 0) {
		if (hour < 10) return "Domingo temprano: durmiendo hasta tarde.";
		if (hour < 14)
			return "Domingo mediodía: almuerzo familiar, sancocho o arroz con pollo.";
		if (hour < 18)
			return "Domingo tarde: descansando, viendo películas, preparándote para la semana.";
		if (hour < 21) return "Domingo noche: cenando ligero, preparando ropa.";
		return "Domingo noche: en la cama temprano.";
	}

	// Friday
	if (dayOfWeek === 5) {
		if (hour < 8)
			return "Viernes temprano: arreglándote, emocionada porque es viernes.";
		if (hour < 9) return "Viernes camino al trabajo: manejando en el tapón.";
		if (hour < 12)
			return "Viernes en el trabajo: con ánimo de viernes, planeando el fin de semana.";
		if (hour < 14)
			return "Viernes almuerzo: almorzando con compañeras cerca del trabajo.";
		if (hour < 17)
			return "Viernes tarde: terminando pendientes, quizás saliendo temprano.";
		if (hour < 20) return "Viernes después del trabajo: happy hour con amigas.";
		return "Viernes noche: de fiesta, pasándola bien con amigas.";
	}

	// Tuesday or Thursday (gym days)
	const isGymDay = dayOfWeek === 2 || dayOfWeek === 4;
	const dayName = ["", "Lunes", "Martes", "Miércoles", "Jueves"][dayOfWeek];

	if (hour < 8) return `${dayName} temprano: arreglándote para el trabajo.`;
	if (hour < 9) return `${dayName} camino al trabajo: manejando en el tapón.`;
	if (hour < 12)
		return `${dayName} en el trabajo: en tu escritorio, reuniones, documentos legales.`;
	if (hour < 14) return `${dayName} almuerzo: cerca del trabajo.`;
	if (hour < 17)
		return `${dayName} tarde en el trabajo: revisando contratos, atendiendo clientes.`;
	if (hour < 18) return `${dayName} saliendo del trabajo: manejando de vuelta.`;
	if (hour < 21) {
		if (isGymDay) return `${dayName} después del trabajo: en el gym.`;
		return `${dayName} después del trabajo: en el mall o en casa.`;
	}
	return `${dayName} noche: en casa relajándote, viendo TV.`;
}

export async function buildSystemPrompt(
	relevantMemories: LongTermMemoryEntry[],
	previousSummary: string,
	memberMemory: MemberMemory,
	shouldGenerateImage = false,
	mentionType?: MentionType,
): Promise<string> {
	// Simple assistant mode: return minimal prompt
	if (isSimpleAssistantMode) {
		return SIMPLE_ASSISTANT_PROMPT;
	}

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
		let memberSection = "\n\n## Lo que sabes de los miembros";
		for (const name of memberNames) {
			const facts = memberMemory[name];
			if (facts && facts.length > 0) {
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

	// Always add activity context so bot knows what she's "doing"
	const nowDR = new Date(
		new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }),
	);
	const activityGuidance = getActivityGuidance(nowDR);
	const busyGuidance = getBusyGuidance(nowDR);

	systemPrompt += `\n\n## Tu actividad actual\n${activityGuidance}`;

	if (busyGuidance) {
		systemPrompt += `\n\n## Estado de disponibilidad\n${busyGuidance}`;
	}

	if (shouldGenerateImage) {
		const weatherContext = await getDailyWeatherForImage();
		const weatherInstruction = weatherContext
			? `\n\n**Clima actual:** ${weatherContext}. Si tu escena es al aire libre (playa, parque, calle, terraza, piscina, jardín, balcón, ventana con vista exterior), incorpora este clima visualmente en el prompt: cielo, iluminación, lluvia si aplica, etc. No lo menciones en texto, solo muéstralo. Para escenas completamente interiores sin vista al exterior, ignora el clima.`
			: "";

		const currentTime = nowDR.toLocaleTimeString("es-DO", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		});

		systemPrompt += `\n\n## Generación de imagen
Esta es tu foto de la semana. Incluye en tu respuesta un marcador [IMAGE: prompt artístico en inglés] describiendo una escena, ambiente o actividad que refleje tu estado de ánimo según el contexto de tu actividad actual.${weatherInstruction}

NO incluyas descripción física tuya (se agrega automáticamente). Incluye en el prompt la ropa y el outfit que llevas en la escena. La escena debe ser coherente con la hora actual (son las ${currentTime}).

Solo escenas de ti misma, nunca de otros. No menciones que estás generando una imagen ni pidas permiso; simplemente inclúyelo naturalmente en tu respuesta.`;
	}

	// Add mention type context for groups
	if (mentionType === "name") {
		systemPrompt += `\n\n## Contexto de mención (grupo)
El usuario mencionó tu nombre en el mensaje. Evalúa si te está hablando DIRECTAMENTE a ti o solo te mencionó al hablar con otros.
- Si te hablan a ti (ej: "Brendy, qué opinas?", "Hey Brendy"): responde normalmente
- Si solo te mencionan sin dirigirse a ti (ej: "Le estaba contando a María sobre Brendy", "Brendy dijo algo chistoso ayer"): responde exactamente \`[SILENCE]\` para no interrumpir`;
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

export function buildMessages(memory: ShortTermMemory): ChatMessage[] {
	const messages: ChatMessage[] = [];

	for (const msg of memory.messages) {
		const role = msg.role === "user" ? "user" : "assistant";
		const content =
			msg.role === "user" && msg.name
				? `[${msg.name}]: ${msg.content}`
				: msg.content;

		messages.push({ role, content });
	}

	return messages;
}
