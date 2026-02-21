import {
	getCurrentWeatherContext,
	getDailyWeatherForImage,
} from "./daily-weather.ts";
import type { MentionType } from "./handlers.ts";
import { isHoliday } from "./holidays.ts";
import { loadPermanent, normalizeName } from "./memory.ts";
import type { ChatMessage } from "./providers/types.ts";
import type { Episode, SemanticFact, SensoryBuffer } from "./types.ts";

export const isSimpleAssistantMode =
	process.env.SIMPLE_ASSISTANT_MODE === "true";

const SIMPLE_ASSISTANT_PROMPT = `You are a helpful assistant. Respond clearly and concisely to user questions.`;

/**
 * Determine if it's a "busy" time when Brendy might decline to chat extensively
 * NOTE: Disabled - Brendy now always has time to chat while maintaining her routine
 */
function getBusyGuidance(_now: Date): string | null {
	return null;
}

/**
 * Get activity guidance from a coherent day plan.
 * The plan is selected deterministically by RD date, so it stays consistent all day.
 */
interface DailyPlan {
	name: string;
	blocks: Array<{
		endHour: number;
		text: string;
	}>;
}

function getRDDateKey(now: Date): string {
	return now.toLocaleDateString("en-CA", {
		timeZone: "America/Santo_Domingo",
	});
}

function hashString(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function pickDeterministic<T>(dateKey: string, seed: string, options: T[]): T {
	if (options.length === 0) throw new Error("Options cannot be empty");
	const idx = hashString(`${dateKey}:${seed}`) % options.length;
	const selected = options[idx];
	if (selected === undefined)
		throw new Error("Invalid deterministic selection");
	return selected;
}

function getCurrentBlockText(plan: DailyPlan, hour: number): string {
	for (const block of plan.blocks) {
		if (hour < block.endHour) return block.text;
	}
	return plan.blocks[plan.blocks.length - 1]?.text ?? "En casa relajándote.";
}

function getHolidayPlan(dateKey: string): DailyPlan {
	return pickDeterministic(dateKey, "holiday-plan", [
		{
			name: "Día de playa",
			blocks: [
				{ endHour: 10, text: "Feriado temprano: descansando en casa." },
				{
					endHour: 13,
					text: "Feriado mañana: preparándote para ir a la playa.",
				},
				{ endHour: 18, text: "Feriado tarde: en la playa disfrutando el día." },
				{
					endHour: 21,
					text: "Feriado noche temprano: regresando de la playa y duchándote.",
				},
				{ endHour: 24, text: "Feriado noche: en casa relajándote." },
			],
		},
		{
			name: "Paseo y piscina",
			blocks: [
				{ endHour: 10, text: "Feriado temprano: durmiendo un poco más." },
				{
					endHour: 13,
					text: "Feriado mañana: desayunando tranquila y saliendo de paseo.",
				},
				{
					endHour: 18,
					text: "Feriado tarde: en piscina o terraza con amigas.",
				},
				{ endHour: 21, text: "Feriado noche temprano: cenando fuera." },
				{ endHour: 24, text: "Feriado noche: de vuelta en casa, descansando." },
			],
		},
	]);
}

function getSaturdayPlan(dateKey: string): DailyPlan {
	return pickDeterministic(dateKey, "saturday-plan", [
		{
			name: "Self-care y salida",
			blocks: [
				{
					endHour: 10,
					text: "Sábado temprano: durmiendo hasta tarde, en pijama.",
				},
				{
					endHour: 13,
					text: "Sábado mañana: rutina self-care, salón de uñas y peluquería.",
				},
				{
					endHour: 18,
					text: "Sábado tarde: en el mall y tomando café con amigas.",
				},
				{
					endHour: 21,
					text: "Sábado noche temprano: arreglándote para salir a cenar.",
				},
				{ endHour: 24, text: "Sábado noche: en restaurante o bar con amigas." },
			],
		},
		{
			name: "Día completo de playa",
			blocks: [
				{
					endHour: 10,
					text: "Sábado temprano: organizándote para un día de playa.",
				},
				{
					endHour: 13,
					text: "Sábado mañana: camino a la playa con tu bolso listo.",
				},
				{ endHour: 18, text: "Sábado tarde: en la playa, disfrutando el sol." },
				{
					endHour: 21,
					text: "Sábado noche temprano: volviendo a casa y duchándote.",
				},
				{
					endHour: 24,
					text: "Sábado noche: en casa relajándote con una serie o película.",
				},
			],
		},
		{
			name: "Recados y descanso",
			blocks: [
				{ endHour: 10, text: "Sábado temprano: durmiendo un poco más." },
				{
					endHour: 13,
					text: "Sábado mañana: desayuno tardío y organizando pendientes.",
				},
				{
					endHour: 18,
					text: "Sábado tarde: haciendo recados y compras en el supermercado.",
				},
				{ endHour: 21, text: "Sábado noche temprano: cenando en casa." },
				{ endHour: 24, text: "Sábado noche: tranquila en casa, descansando." },
			],
		},
	]);
}

function getSundayPlan(dateKey: string): DailyPlan {
	return pickDeterministic(dateKey, "sunday-plan", [
		{
			name: "Domingo familiar",
			blocks: [
				{ endHour: 10, text: "Domingo temprano: durmiendo hasta tarde." },
				{
					endHour: 14,
					text: "Domingo mediodía: en almuerzo familiar, compartiendo en casa.",
				},
				{
					endHour: 18,
					text: "Domingo tarde: sobremesa tranquila y descanso en familia.",
				},
				{ endHour: 21, text: "Domingo noche temprano: preparando la semana." },
				{ endHour: 24, text: "Domingo noche: en casa, acostándote temprano." },
			],
		},
		{
			name: "Domingo de descanso total",
			blocks: [
				{ endHour: 10, text: "Domingo temprano: durmiendo tarde y relajada." },
				{
					endHour: 14,
					text: "Domingo mediodía: brunch en casa y viendo algo ligero.",
				},
				{
					endHour: 18,
					text: "Domingo tarde: descansando, viendo películas y recargando energías.",
				},
				{
					endHour: 21,
					text: "Domingo noche temprano: cena ligera y rutina de piel.",
				},
				{ endHour: 24, text: "Domingo noche: preparándote para dormir." },
			],
		},
	]);
}

function getFridayPlan(dateKey: string): DailyPlan {
	return pickDeterministic(dateKey, "friday-plan", [
		{
			name: "Viernes social",
			blocks: [
				{
					endHour: 8,
					text: "Viernes temprano: arreglándote y con ánimo de viernes.",
				},
				{ endHour: 9, text: "Viernes mañana: camino al trabajo, en el tapón." },
				{
					endHour: 12,
					text: "Viernes en el trabajo: cerrando pendientes y reuniones.",
				},
				{ endHour: 14, text: "Viernes almuerzo: comiendo cerca del trabajo." },
				{
					endHour: 17,
					text: "Viernes tarde: terminando tareas para salir a tiempo.",
				},
				{
					endHour: 20,
					text: "Viernes después del trabajo: en happy hour con amigas.",
				},
				{ endHour: 24, text: "Viernes noche: compartiendo y pasándola bien." },
			],
		},
		{
			name: "Viernes tranquilo",
			blocks: [
				{
					endHour: 8,
					text: "Viernes temprano: arreglándote para comenzar el día.",
				},
				{ endHour: 9, text: "Viernes mañana: camino al trabajo, en el tapón." },
				{
					endHour: 12,
					text: "Viernes en el trabajo: resolviendo pendientes de la semana.",
				},
				{
					endHour: 14,
					text: "Viernes almuerzo: almorzando cerca de la oficina.",
				},
				{
					endHour: 17,
					text: "Viernes tarde: cerrando temas y organizando el lunes.",
				},
				{
					endHour: 20,
					text: "Viernes después del trabajo: regresando a casa para descansar.",
				},
				{
					endHour: 24,
					text: "Viernes noche: noche tranquila en casa con serie o película.",
				},
			],
		},
	]);
}

function getWeekdayPlan(dayOfWeek: number, dateKey: string): DailyPlan {
	const dayName =
		["", "Lunes", "Martes", "Miércoles", "Jueves"][dayOfWeek] ?? "Día laboral";
	const isGymDay = dayOfWeek === 2 || dayOfWeek === 4;

	if (isGymDay) {
		return {
			name: `${dayName} laboral con gym`,
			blocks: [
				{
					endHour: 8,
					text: `${dayName} temprano: arreglándote para el trabajo.`,
				},
				{
					endHour: 9,
					text: `${dayName} mañana: camino al trabajo, en el tapón.`,
				},
				{
					endHour: 12,
					text: `${dayName} en el trabajo: en reuniones y documentos legales.`,
				},
				{
					endHour: 14,
					text: `${dayName} almuerzo: comiendo cerca del trabajo.`,
				},
				{
					endHour: 17,
					text: `${dayName} tarde en el trabajo: atendiendo pendientes y clientes.`,
				},
				{
					endHour: 18,
					text: `${dayName} final de tarde: saliendo de la oficina y manejando de vuelta.`,
				},
				{
					endHour: 21,
					text: `${dayName} noche temprano: en el gym entrenando.`,
				},
				{ endHour: 24, text: `${dayName} noche: en casa descansando.` },
			],
		};
	}

	return pickDeterministic(dateKey, `${dayName}-weekday-plan`, [
		{
			name: `${dayName} laboral en casa`,
			blocks: [
				{
					endHour: 8,
					text: `${dayName} temprano: arreglándote para el trabajo.`,
				},
				{
					endHour: 9,
					text: `${dayName} mañana: camino al trabajo, en el tapón.`,
				},
				{
					endHour: 12,
					text: `${dayName} en el trabajo: en tu escritorio y reuniones.`,
				},
				{
					endHour: 14,
					text: `${dayName} almuerzo: comiendo cerca de la oficina.`,
				},
				{
					endHour: 17,
					text: `${dayName} tarde en el trabajo: cerrando pendientes del día.`,
				},
				{
					endHour: 18,
					text: `${dayName} final de tarde: manejando de regreso a casa.`,
				},
				{
					endHour: 21,
					text: `${dayName} noche temprano: en casa, cenando y relajándote.`,
				},
				{ endHour: 24, text: `${dayName} noche: tranquila en casa.` },
			],
		},
		{
			name: `${dayName} laboral con salida breve`,
			blocks: [
				{
					endHour: 8,
					text: `${dayName} temprano: arreglándote para el trabajo.`,
				},
				{
					endHour: 9,
					text: `${dayName} mañana: camino al trabajo, en el tapón.`,
				},
				{
					endHour: 12,
					text: `${dayName} en el trabajo: reuniones y revisiones legales.`,
				},
				{ endHour: 14, text: `${dayName} almuerzo: comiendo por la zona.` },
				{
					endHour: 17,
					text: `${dayName} tarde en el trabajo: terminando reportes y mensajes.`,
				},
				{
					endHour: 18,
					text: `${dayName} final de tarde: saliendo de la oficina.`,
				},
				{
					endHour: 21,
					text: `${dayName} noche temprano: pasando por el mall o tomando algo ligero.`,
				},
				{ endHour: 24, text: `${dayName} noche: en casa descansando.` },
			],
		},
	]);
}

function getActivityGuidance(now: Date): string {
	const hour = now.getHours();
	const dayOfWeek = now.getDay();
	const dateKey = getRDDateKey(now);

	const plan = isHoliday(now)
		? getHolidayPlan(dateKey)
		: dayOfWeek === 6
			? getSaturdayPlan(dateKey)
			: dayOfWeek === 0
				? getSundayPlan(dateKey)
				: dayOfWeek === 5
					? getFridayPlan(dateKey)
					: getWeekdayPlan(dayOfWeek, dateKey);

	const currentActivity = getCurrentBlockText(plan, hour);
	return `${currentActivity}\nPlan del día: ${plan.name}. Mantén continuidad entre tus respuestas.`;
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

	const now = new Date().toLocaleString("es-DO", {
		timeZone: "America/Santo_Domingo",
		dateStyle: "full",
		timeStyle: "short",
	});
	let systemPrompt = `${permanent}\n\n## Fecha y hora actual\n${now} (hora de República Dominicana)`;

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

			let memberSection = "\n\n## Lo que sabes de los miembros\nEsta información es CONTEXTO, no un guion. Solo menciona un dato si surge NATURALMENTE en la conversación. NUNCA fuerces una mención. Si el tema no tiene relación con lo que sabes, no lo traigas a colación.";
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
	const nowDR = new Date(
		new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }),
	);
	const activityGuidance = getActivityGuidance(nowDR);
	const busyGuidance = getBusyGuidance(nowDR);

	systemPrompt += `\n\n## Tu actividad actual\n${activityGuidance}`;

	if (busyGuidance) {
		systemPrompt += `\n\n## Estado de disponibilidad\n${busyGuidance}`;
	}

	const weatherContext = await getCurrentWeatherContext();
	if (weatherContext) {
		systemPrompt += `\n\n## Clima actual\n${weatherContext}\n(Usa esta información si el usuario pregunta por el clima o si es relevante para la conversación.)`;
	}

	if (shouldGenerateImage) {
		const imageWeather = await getDailyWeatherForImage();
		const weatherInstruction = imageWeather
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
		systemPrompt += `\n\n## Contexto de mención (grupo)
El usuario mencionó tu nombre en el mensaje. Evalúa si te está hablando DIRECTAMENTE a ti o solo te mencionó al hablar con otros.
- Si te hablan a ti (ej: "Brendy, qué opinas?", "Hey Brendy"): responde normalmente
- Si solo te mencionan sin dirigirse a ti (ej: "Le estaba contando a María sobre Brendy", "Brendy dijo algo chistoso ayer"): responde exactamente \`[SILENCE]\` para no interrumpir`;
	}

	return systemPrompt;
}

export function buildMessages(buffer: SensoryBuffer): ChatMessage[] {
	const messages: ChatMessage[] = [];

	for (const msg of buffer.messages) {
		const role = msg.role === "user" ? "user" : "assistant";
		const content =
			msg.role === "user" && msg.name
				? `[${msg.name}]: ${msg.content}`
				: msg.content;

		messages.push({ role, content });
	}

	return messages;
}
