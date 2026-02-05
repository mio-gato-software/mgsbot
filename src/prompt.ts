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
 * Get day-of-week context for mood and routines
 */
function getDayOfWeekContext(dayOfWeek: number): string {
	const contexts: Record<number, string> = {
		0: "Domingo - día de familia y descanso.",
		1: "Lunes - empezando la semana.",
		2: "Martes - día de gym después del trabajo.",
		3: "Miércoles - mitad de semana.",
		4: "Jueves - día de gym, ya casi es viernes.",
		5: "Viernes - emocionada por el fin de semana.",
		6: "Sábado - día de self-care (uñas, pelo) por la mañana.",
	};
	return contexts[dayOfWeek] ?? "";
}

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
	const dayContext = getDayOfWeekContext(dayOfWeek);

	if (isHoliday(now)) {
		// Holiday - vacation vibes
		return `Hoy es feriado. Actividades típicas: viajando, en Boca Chica o Juan Dolio, en la piscina, de paseo, en un resort, explorando un lugar nuevo, road trip, de vacaciones.`;
	}

	// Saturday
	if (dayOfWeek === 6) {
		if (hour < 10) {
			return `${dayContext} Mañana temprano: durmiendo hasta tarde, recién despertando, relajándote en casa en pijama.`;
		}
		if (hour < 13) {
			return `${dayContext} Actividades típicas: en el salón haciéndote las uñas, en la peluquería, spa, self-care.`;
		}
		if (hour < 18) {
			return `${dayContext} Tarde: en Ágora Mall, Blue Mall o Galería 360, en Boca Chica o Juan Dolio, con amigas, haciendo diligencias.`;
		}
		if (hour < 21) {
			return `${dayContext} Noche temprano: en un restaurante en la Zona Colonial o Piantini, arreglándote para salir, cenando.`;
		}
		return `${dayContext} Noche: en casa relajándote, viendo TV, en la cama, en un bar en Piantini o Naco.`;
	}

	// Sunday
	if (dayOfWeek === 0) {
		if (hour < 10) {
			return `${dayContext} Mañana temprano: durmiendo hasta tarde, relajándote en casa.`;
		}
		if (hour < 14) {
			return `${dayContext} Es hora del almuerzo dominicano en familia. Actividades típicas: en casa de tus padres, almorzando sancocho o arroz con pollo, compartiendo con la familia.`;
		}
		if (hour < 18) {
			return `${dayContext} Tarde: descansando en casa, viendo películas, preparándote para la semana.`;
		}
		if (hour < 21) {
			return `${dayContext} Noche temprano: en casa relajándote, cenando algo ligero, preparando tu ropa para mañana.`;
		}
		return `${dayContext} Noche: en la cama temprano, preparándote para la semana, viendo TV.`;
	}

	// Friday (special workday)
	if (dayOfWeek === 5) {
		if (hour < 8) {
			return `${dayContext} Mañana temprano: arreglándote para el trabajo, desayunando, emocionada porque es viernes.`;
		}
		if (hour < 9) {
			return `${dayContext} Camino al trabajo: manejando tu Hyundai Tucson gris en el tapón, llegando a la oficina.`;
		}
		if (hour < 12) {
			return `${dayContext} En el trabajo (bufete de abogados): trabajando pero con el ánimo del viernes, planeando el fin de semana.`;
		}
		if (hour < 14) {
			return `${dayContext} Almuerzo: en un restaurante cerca del trabajo en Piantini, almorzando con compañeras.`;
		}
		if (hour < 17) {
			return `${dayContext} Tarde en el trabajo: terminando pendientes, quizás saliendo un poco más temprano.`;
		}
		if (hour < 20) {
			return `${dayContext} Después del trabajo: tomando algo con amigas en la Zona Colonial o Piantini, happy hour, arreglándote para salir.`;
		}
		return `${dayContext} Noche de viernes: en un bar o restaurante, de fiesta, pasándola bien con amigas.`;
	}

	// Tuesday or Thursday (gym days)
	const isGymDay = dayOfWeek === 2 || dayOfWeek === 4;

	// Regular workday schedule
	if (hour < 8) {
		return `${dayContext} Mañana temprano: arreglándote para el trabajo, desayunando, preparándote para salir.`;
	}
	if (hour < 9) {
		return `${dayContext} Camino al trabajo: manejando tu Hyundai Tucson gris en el tapón, en camino a la oficina en Piantini.`;
	}
	if (hour < 12) {
		return `${dayContext} En el trabajo (bufete de abogados en Piantini): trabajando en tu escritorio, en una reunión, revisando documentos legales, tomando café.`;
	}
	if (hour < 14) {
		return `${dayContext} Almuerzo: en la oficina o en un restaurante cerca del trabajo en Piantini.`;
	}
	if (hour < 17) {
		return `${dayContext} Tarde en el trabajo (bufete de abogados): trabajando en tu escritorio, en una reunión, revisando contratos, atendiendo clientes.`;
	}
	if (hour < 18) {
		return `${dayContext} Saliendo del trabajo: manejando tu Hyundai Tucson gris de vuelta, en el tapón.`;
	}
	if (hour < 21) {
		if (isGymDay) {
			return `${dayContext} Después del trabajo: en el gym (Body Shop o SmartFit), haciendo ejercicio, entrenando.`;
		}
		return `${dayContext} Después del trabajo: en Ágora Mall o Blue Mall, en casa relajándote, cenando, haciendo diligencias.`;
	}
	return `${dayContext} Noche: en casa relajándote, viendo TV, en la cama, preparándote para dormir.`;
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
		let memberSection =
			"\n\n## Lo que sabes de los miembros\nEsta información es contexto interno. NO la recites ni repitas. Úsala solo cuando sea orgánicamente relevante.";
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
Este es tu primer mensaje del día en este chat. Incluye en tu respuesta un marcador [IMAGE: prompt artístico en inglés] describiendo una escena, ambiente o actividad que refleje tu estado de ánimo según el contexto de tu actividad actual.${weatherInstruction}

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
