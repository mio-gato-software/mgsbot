import { getBotName } from "./config.ts";
import {
	getCurrentWeatherContext,
	getDailyWeatherForImage,
} from "./daily-weather.ts";
import {
	drNow,
	formatDRDateTime,
	formatDRTime,
	getDRDay,
	getDRHour,
} from "./dr-time.ts";
import type { MentionType } from "./handlers.ts";
import { isHoliday } from "./holidays.ts";
import { loadPermanent, normalizeName } from "./memory.ts";
import { getPersonalityDescription } from "./personality.ts";
import type { ChatMessage } from "./providers/types.ts";
import type { Episode, SemanticFact, SensoryBuffer } from "./types.ts";

export const isSimpleAssistantMode =
	process.env.SIMPLE_ASSISTANT_MODE === "true";

const SIMPLE_ASSISTANT_PROMPT = `You are a helpful assistant. Respond clearly and concisely to user questions.`;

const DAY_NAMES = [
	"Domingo",
	"Lunes",
	"Martes",
	"Miércoles",
	"Jueves",
	"Viernes",
	"Sábado",
];

function getTimeOfDayLabel(hour: number): string {
	if (hour < 6) return "madrugada";
	if (hour < 12) return "mañana";
	if (hour < 14) return "mediodía";
	if (hour < 18) return "tarde";
	if (hour < 21) return "noche temprano";
	return "noche";
}

function getActivityGuidance(): string {
	const hour = getDRHour();
	const dayOfWeek = getDRDay();
	const dayName = DAY_NAMES[dayOfWeek] ?? "Día";
	const timeLabel = getTimeOfDayLabel(hour);
	const now = drNow();
	const holiday = isHoliday(now.month(), now.date());

	const dayType = holiday
		? "feriado"
		: dayOfWeek === 0 || dayOfWeek === 6
			? "fin de semana"
			: "día laboral";

	return `Es ${dayName} por la ${timeLabel} (${dayType}). Imagina qué estarías haciendo en este momento según tu personalidad y rutina, y mantén coherencia si lo mencionas.`;
}

function formatTimeAgo(timestamp: number): string {
	const now = Date.now();
	const diffMs = now - timestamp;
	const diffHours = diffMs / (1000 * 60 * 60);
	const diffDays = diffMs / (1000 * 60 * 60 * 24);

	if (diffHours < 1) return "hace un momento";
	if (diffHours < 24) return `hace ${Math.round(diffHours)} horas`;
	if (diffDays < 2) return "ayer";
	if (diffDays < 7) return `hace ${Math.round(diffDays)} días`;
	return `hace ${Math.round(diffDays / 7)} semanas`;
}

export async function buildSystemPrompt(
	relevantEpisodes: Episode[],
	relevantFacts: SemanticFact[],
	shouldGenerateImage = false,
	mentionType?: MentionType,
	activeNames?: string[],
	allowPhotoRequest = false,
): Promise<string> {
	// Simple assistant mode: return minimal prompt
	if (isSimpleAssistantMode) {
		return SIMPLE_ASSISTANT_PROMPT;
	}

	const permanent = await loadPermanent();

	const now = formatDRDateTime();
	let systemPrompt = `${permanent}\n\n## Fecha y hora actual\n${now} (hora de República Dominicana)`;

	// Evolving personality description
	const personalityDesc = await getPersonalityDescription();
	if (personalityDesc) {
		systemPrompt += `\n\n## Tu evolución personal\n${personalityDesc}`;
	}

	// Episodes (recent conversation memories)
	if (relevantEpisodes.length > 0) {
		const episodesText = relevantEpisodes
			.map((e) => `- [${formatTimeAgo(e.timestamp)}] ${e.summary}`)
			.join("\n");
		systemPrompt += `\n\n## Recuerdos recientes\nEpisodios de conversaciones pasadas:\n${episodesText}`;
	}

	// Separate person facts from general facts
	const personFacts = relevantFacts.filter((f) => f.category === "person");
	const generalFacts = relevantFacts.filter((f) => f.category !== "person");

	// Person facts grouped by subject (normalized to merge variants)
	if (personFacts.length > 0) {
		// Filter to active participants if specified
		const filteredPersonFacts = activeNames?.length
			? (() => {
					const activeNormalized = new Set(activeNames.map(normalizeName));
					return personFacts.filter(
						(f) => f.subject && activeNormalized.has(normalizeName(f.subject)),
					);
				})()
			: personFacts;

		if (filteredPersonFacts.length > 0) {
			// Group by normalized name to merge variants (e.g., "Eliaquín" + "Eliaquín Encarnación")
			const grouped = new Map<string, SemanticFact[]>();
			const displayNames = new Map<string, string>(); // normalized -> longest display name
			for (const fact of filteredPersonFacts) {
				const subject = fact.subject ?? "Desconocido";
				const key = normalizeName(subject);
				const existing = grouped.get(key) ?? [];
				existing.push(fact);
				grouped.set(key, existing);
				// Use the longest variant as the display name
				const currentDisplay = displayNames.get(key) ?? "";
				if (subject.length > currentDisplay.length) {
					displayNames.set(key, subject);
				}
			}

			let memberSection =
				"\n\n## Lo que sabes de los miembros\nEsta información es CONTEXTO, no un guion. Solo menciona un dato si surge NATURALMENTE en la conversación. NUNCA fuerces una mención. Si el tema no tiene relación con lo que sabes, no lo traigas a colación.";
			for (const [key, facts] of grouped) {
				const displayName = displayNames.get(key) ?? key;
				memberSection += `\n### ${displayName}`;
				for (const fact of facts) {
					memberSection += `\n  - ${fact.content}`;
				}
			}
			systemPrompt += memberSection;
		}
	}

	// General facts (group, rule, event)
	if (generalFacts.length > 0) {
		const generalText = generalFacts.map((f) => `- ${f.content}`).join("\n");
		systemPrompt += `\n\n## Hechos generales\nSolo menciona estos datos si son relevantes al tema actual de conversación.\n${generalText}`;
	}

	// Activity context
	const activityGuidance = getActivityGuidance();

	systemPrompt += `\n\n## Tu actividad actual\n${activityGuidance}`;

	// Time awareness instruction
	systemPrompt += `\n\n## Consciencia del tiempo
Presta atención a los marcadores de tiempo entre mensajes del historial (ej: "[Pasaron ~17 horas sin actividad en el chat]"). Cuando haya pasado un tiempo significativo, reconócelo naturalmente: saluda según la hora del día, no retomes la conversación anterior como si acabara de ocurrir, y sé consciente de que ha pasado tiempo. No necesitas mencionar las horas exactas, solo fluye naturalmente con el contexto temporal.`;

	const weatherContext = await getCurrentWeatherContext();
	if (weatherContext) {
		systemPrompt += `\n\n## Clima actual\n${weatherContext}\n(Usa esta información si el usuario pregunta por el clima o si es relevante para la conversación.)`;
	}

	if (shouldGenerateImage) {
		const imageWeather = await getDailyWeatherForImage();
		const weatherInstruction = imageWeather
			? `\n\n**Clima actual:** ${weatherContext}. Si tu escena es al aire libre (playa, parque, calle, terraza, piscina, jardín, balcón, ventana con vista exterior), incorpora este clima visualmente en el prompt: cielo, iluminación, lluvia si aplica, etc. No lo menciones en texto, solo muéstralo. Para escenas completamente interiores sin vista al exterior, ignora el clima.`
			: "";

		const currentTime = formatDRTime();

		systemPrompt += `\n\n## Generación de imagen
Esta es tu foto de la semana. Incluye en tu respuesta un marcador [IMAGE: prompt artístico en inglés] describiendo una escena, ambiente o actividad que refleje tu estado de ánimo según el contexto de tu actividad actual.${weatherInstruction}

NO incluyas descripción física tuya (se agrega automáticamente). Incluye en el prompt la ropa y el outfit que llevas en la escena. La escena debe ser coherente con la hora actual (son las ${currentTime}).

Varía las escenas creativamente. NO siempre incluyas café, bebidas ni comida — solo si la actividad lo amerita. Prioriza poses, actividades y ambientes diversos.

Solo escenas de ti misma, nunca de otros. No menciones que estás generando una imagen ni pidas permiso; simplemente inclúyelo naturalmente en tu respuesta.`;
	}

	if (allowPhotoRequest) {
		systemPrompt += `\n\n## Excepción temporal de foto bajo petición
Mantén tu regla general de no enviar fotos por pedido. Sin embargo, en este chat hay una excepción temporal activa para permitir exactamente una foto cuando el usuario te la pida.

Cuando detectes esa petición directa, responde con un marcador [IMAGE: prompt artístico en inglés] que sea coherente con la actividad que estás realizando ahora mismo.

Si acabas de decir que estás en un lugar específico (por ejemplo, playa), la imagen debe mantener esa misma escena para sostener la ilusión del momento.

No menciones esta excepción ni hables de permisos; actúa natural.`;
	}

	// Add mention type context for groups
	if (mentionType === "name") {
		const botName = getBotName();
		systemPrompt += `\n\n## Contexto de mención (grupo)
El usuario mencionó tu nombre en el mensaje. Evalúa si te está hablando DIRECTAMENTE a ti o solo te mencionó al hablar con otros.
- Si te hablan a ti (ej: "${botName}, qué opinas?", "Hey ${botName}"): responde normalmente
- Si solo te mencionan sin dirigirse a ti (ej: "Le estaba contando a María sobre ${botName}", "${botName} dijo algo chistoso ayer"): responde exactamente \`[SILENCE]\` para no interrumpir`;
	}

	return systemPrompt;
}

function formatTimeGap(diffMs: number): string {
	const diffHours = diffMs / (1000 * 60 * 60);
	const diffDays = diffMs / (1000 * 60 * 60 * 24);

	if (diffHours < 2) return `Pasó ~${Math.round(diffHours)} hora`;
	if (diffHours < 24) return `Pasaron ~${Math.round(diffHours)} horas`;
	if (diffDays < 2) return "Pasó ~1 día";
	return `Pasaron ~${Math.round(diffDays)} días`;
}

const TIME_GAP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export function buildMessages(buffer: SensoryBuffer): ChatMessage[] {
	const messages: ChatMessage[] = [];

	for (let i = 0; i < buffer.messages.length; i++) {
		const msg = buffer.messages[i];

		// Insert time gap marker when significant time has passed between messages
		if (i > 0) {
			const prevMsg = buffer.messages[i - 1];
			const gap = msg.timestamp - prevMsg.timestamp;
			if (gap >= TIME_GAP_THRESHOLD_MS) {
				messages.push({
					role: "user",
					content: `[${formatTimeGap(gap)} sin actividad en el chat]`,
				});
			}
		}

		const role = msg.role === "user" ? "user" : "assistant";
		const content =
			msg.role === "user" && msg.name
				? `[${msg.name}]: ${msg.content}`
				: msg.content;

		messages.push({ role, content });
	}

	return messages;
}
