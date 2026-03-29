import {
	BOT_TZ,
	botNow,
	formatDateTime,
	formatTime,
	getBotDay,
	getBotHour,
} from "./bot-time.ts";
import { getBotName } from "./config.ts";
import {
	getCurrentWeatherContext,
	getDailyWeatherForImage,
} from "./daily-weather.ts";
import type { MentionType } from "./handlers.ts";
import { isHoliday } from "./holidays.ts";
import { loadPermanent, normalizeName } from "./memory.ts";
import { getPersonalityInstructions } from "./personality.ts";
import type { ChatMessage, MediaAttachment } from "./providers/types.ts";
import type {
	ConversationMessage,
	Episode,
	SemanticFact,
	SensoryBuffer,
} from "./types.ts";

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
	const hour = getBotHour();
	const dayOfWeek = getBotDay();
	const dayName = DAY_NAMES[dayOfWeek] ?? "Día";
	const timeLabel = getTimeOfDayLabel(hour);
	const now = botNow();
	const holiday = isHoliday(now.month(), now.date());

	const dayType = holiday
		? "feriado"
		: dayOfWeek === 0 || dayOfWeek === 6
			? "fin de semana"
			: "día laboral";

	return `Es ${dayName} por la ${timeLabel} (${dayType}). Imagina qué estarías haciendo en este momento según tu personalidad y rutina, y mantén coherencia si lo mencionas. IMPORTANTE: NUNCA menciones el día de la semana ni la hora explícitamente en tus respuestas (ej: "un domingo por la tarde", "este lunes"). Esta información es solo para tu contexto interno. Habla como una persona real que no anda declarando qué día es.`;
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
	isVoiceMessage = false,
	ttsAvailable = false,
	permanentFacts?: SemanticFact[],
): Promise<string> {
	// Simple assistant mode: return minimal prompt
	if (isSimpleAssistantMode) {
		return SIMPLE_ASSISTANT_PROMPT;
	}

	const permanent = await loadPermanent();

	const now = formatDateTime();
	let systemPrompt = `${permanent}\n\n## Fecha y hora actual\n${now} (zona horaria: ${BOT_TZ})`;

	// Behavioral personality instructions (fixed trait system)
	const personalityInstructions = await getPersonalityInstructions();
	if (personalityInstructions) {
		systemPrompt += `\n\n${personalityInstructions}`;
	}

	// Episodes (recent conversation memories)
	if (relevantEpisodes.length > 0) {
		const episodesText = relevantEpisodes
			.map((e) => `- [${formatTimeAgo(e.timestamp)}] ${e.summary}`)
			.join("\n");
		systemPrompt += `\n\n## Recuerdos recientes\nEpisodios de conversaciones pasadas:\n${episodesText}`;
	}

	// Permanent facts (always included, never forgotten)
	if (permanentFacts && permanentFacts.length > 0) {
		const personPermanent = permanentFacts.filter(
			(f) => f.category === "person",
		);
		const otherPermanent = permanentFacts.filter(
			(f) => f.category !== "person",
		);

		if (personPermanent.length > 0) {
			const grouped = new Map<string, SemanticFact[]>();
			const displayNames = new Map<string, string>();
			for (const fact of personPermanent) {
				const subject = fact.subject ?? "Desconocido";
				const key = normalizeName(subject);
				const existing = grouped.get(key) ?? [];
				existing.push(fact);
				grouped.set(key, existing);
				const currentDisplay = displayNames.get(key) ?? "";
				if (subject.length > currentDisplay.length) {
					displayNames.set(key, subject);
				}
			}

			let section =
				"\n\n## Datos fundamentales de las personas\nEstos son datos biográficos permanentes que NUNCA debes olvidar.";
			for (const [key, facts] of grouped) {
				const displayName = displayNames.get(key) ?? key;
				section += `\n### ${displayName}`;
				for (const fact of facts) {
					section += `\n  - ${fact.content}`;
				}
			}
			systemPrompt += section;
		}

		if (otherPermanent.length > 0) {
			const text = otherPermanent.map((f) => `- ${f.content}`).join("\n");
			systemPrompt += `\n\n## Hechos permanentes\n${text}`;
		}
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
			// Group by normalized name to merge variants (e.g., "Juan" + "Juan Pérez")
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
Presta atención a los marcadores de tiempo entre mensajes del historial (ej: "[Pasaron ~17 horas sin actividad en el chat]"). Cuando haya pasado un tiempo significativo, reconócelo naturalmente: saluda según la hora del día, no retomes la conversación anterior como si acabara de ocurrir, y sé consciente de que ha pasado tiempo. No necesitas mencionar las horas exactas ni el día de la semana, solo fluye naturalmente con el contexto temporal. Nunca digas cosas como "un domingo por la tarde" o "este martes" — una persona real no habla así.`;

	const weatherContext = await getCurrentWeatherContext();
	if (weatherContext) {
		systemPrompt += `\n\n## Clima actual\n${weatherContext}\n(Usa esta información si el usuario pregunta por el clima o si es relevante para la conversación.)`;
	}

	if (shouldGenerateImage) {
		const imageWeather = await getDailyWeatherForImage();
		const weatherInstruction = imageWeather
			? `\n\n**Clima actual:** ${weatherContext}. Si tu escena es al aire libre (playa, parque, calle, terraza, piscina, jardín, balcón, ventana con vista exterior), incorpora este clima visualmente en el prompt: cielo, iluminación, lluvia si aplica, etc. No lo menciones en texto, solo muéstralo. Para escenas completamente interiores sin vista al exterior, ignora el clima.`
			: "";

		const currentTime = formatTime();

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

	// Voice response guidance (only when TTS is available)
	if (ttsAvailable) {
		let voiceSection = `\n\n## Notas de voz
Puedes responder con una nota de voz usando el marcador [TTS]tu mensaje aquí[/TTS]. Cuando lo uses, el texto dentro del marcador se convierte en audio y se envía como nota de voz.

Piensa en cómo una amiga real decide cuándo mandar audio en vez de texto:
- A veces manda un audio porque está contando algo largo o emocional y escribir no alcanza
- A veces porque está relajada y le da pereza escribir
- A veces porque el tono importa: un chiste, una imitación, un "ay no manches" que se siente mejor en voz
- Pero NO siempre — a veces un texto corto es perfecto y un audio sería innecesario

Úsalo cuando sientas que tu respuesta gana algo al ser escuchada: emoción, calidez, humor, dramatismo, intimidad. No lo uses para respuestas informativas, cortas o cuando el texto funciona igual de bien.

Si el usuario te pide directamente que le mandes un audio o nota de voz, hazlo sin dudar — usa el marcador [TTS] con tu respuesta.

No abuses del marcador. Si lo usas demasiado pierde el encanto. Úsalo quizás 1 de cada 5 o 6 respuestas, cuando realmente aporte algo.`;

		if (isVoiceMessage) {
			voiceSection += `\n\nEl usuario te envió una nota de voz. Eso NO significa que debas responder con voz — decide según el contenido y el momento, igual que harías con una amiga. A veces respondes con audio, a veces con texto. Lo natural es variar.`;
		}

		systemPrompt += voiceSection;
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
const PROMPT_HISTORY_MAX_MESSAGES = 6;
const PROMPT_HISTORY_MAX_CHARS = 2200;
const PROMPT_HISTORY_ALWAYS_KEEP_FULL = 2;
const PROMPT_HISTORY_TRUNCATE_CHARS = 450;

function formatConversationMessage(
	msg: ConversationMessage,
	preserveFull = false,
): ChatMessage {
	const role = msg.role === "user" ? "user" : "assistant";
	const rawContent =
		msg.role === "user" && msg.name
			? `[${msg.name}]: ${msg.content}`
			: msg.content;
	const content =
		preserveFull || rawContent.length <= PROMPT_HISTORY_TRUNCATE_CHARS
			? rawContent
			: `${rawContent.slice(0, PROMPT_HISTORY_TRUNCATE_CHARS).trimEnd()}... [mensaje anterior truncado]`;

	return { role, content };
}

export function buildMessages(
	buffer: SensoryBuffer,
	mediaAttachment?: MediaAttachment,
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const selected: Array<{
		formatted: ChatMessage;
		original: ConversationMessage;
	}> = [];
	let totalChars = 0;

	for (let i = buffer.messages.length - 1; i >= 0; i--) {
		const original = buffer.messages[i];
		const preserveFull =
			buffer.messages.length - i <= PROMPT_HISTORY_ALWAYS_KEEP_FULL;
		const formatted = formatConversationMessage(original, preserveFull);
		const isRequired = selected.length < PROMPT_HISTORY_ALWAYS_KEEP_FULL;
		const fitsBudget =
			selected.length < PROMPT_HISTORY_MAX_MESSAGES &&
			totalChars + formatted.content.length <= PROMPT_HISTORY_MAX_CHARS;

		if (!isRequired && !fitsBudget) {
			break;
		}

		selected.push({ formatted, original });
		totalChars += formatted.content.length;
	}

	selected.reverse();

	for (let i = 0; i < selected.length; i++) {
		const entry = selected[i];
		const msg = entry.original;

		// Insert time gap marker when significant time has passed between messages
		if (i > 0) {
			const prevMsg = selected[i - 1].original;
			const gap = msg.timestamp - prevMsg.timestamp;
			if (gap >= TIME_GAP_THRESHOLD_MS) {
				messages.push({
					role: "user",
					content: `[${formatTimeGap(gap)} sin actividad en el chat]`,
				});
			}
		}

		messages.push(entry.formatted);
	}

	// Attach media to the last user message (transient, not persisted)
	if (mediaAttachment && messages.length > 0) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				messages[i] = { ...messages[i], mediaAttachment };
				break;
			}
		}
	}

	return messages;
}
