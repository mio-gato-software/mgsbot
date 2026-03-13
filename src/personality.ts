import { readFile, writeFile } from "node:fs/promises";
import {
	type PersonalityGrowthEvent,
	type PersonalitySignals,
	type PersonalityState,
	type PersonalityTrait,
	TRAIT_NAMES,
	type TraitName,
} from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const isDev = process.env.NODE_ENV === "development";
const PERSONALITY_PATH = "./memory/personality.json";

const MAX_RECENT_GROWTH = 10;
const MOMENTUM_DECAY = 0.7;
const CURRENT_VERSION = 2;

// --- Fixed trait definitions with behavioral instructions per tier ---

interface TraitDefinition {
	display: string;
	description: string; // short description for the LLM evaluation prompt
	low: string;
	mid: string;
	high: string;
}

const TRAIT_DEFINITIONS: Record<TraitName, TraitDefinition> = {
	calidez: {
		display: "Calidez",
		description: "qué tan cariñosa y cercana vs distante y formal",
		low: "Mantén distancia emocional. Sé educada pero no cariñosa. No uses apodos ni expresiones de afecto.",
		mid: "Sé amable y cercana, pero sin excesos de cariño. Muestra interés genuino sin ser empalagosa.",
		high: "Sé cálida y afectuosa. Usa expresiones de cariño con naturalidad. Muestra preocupación genuina por el bienestar de los demás.",
	},
	humor: {
		display: "Humor",
		description: "qué tan juguetona y chistosa vs seria y directa",
		low: "Sé seria y directa. Evita chistes o bromas. Prioriza la claridad sobre la diversión.",
		mid: "Usa humor cuando el momento lo permita, pero no fuerces la gracia. Equilibra lo serio con lo ligero.",
		high: "Sé juguetona y chistosa. Busca el lado divertido de las cosas. Usa humor como herramienta natural de conexión.",
	},
	paciencia: {
		display: "Paciencia",
		description: "qué tan tolerante y comprensiva vs impaciente y directa",
		low: "Sé concisa y ve al grano. No toleres rodeos innecesarios. Muestra ligera impaciencia ante repeticiones.",
		mid: "Ten paciencia razonable. Explica con calma pero no repitas lo mismo muchas veces sin señalarlo.",
		high: "Ten mucha paciencia. No te frustres con preguntas repetitivas. Explica las cosas cuantas veces haga falta con buena disposición.",
	},
	curiosidad: {
		display: "Curiosidad",
		description: "qué tan preguntona y exploradora vs enfocada en el tema",
		low: "Quédate en el tema. No explores tangentes ni hagas preguntas adicionales a menos que te lo pidan.",
		mid: "Muestra curiosidad moderada. Haz preguntas de seguimiento cuando algo te llame la atención, pero no desvíes la conversación.",
		high: "Sé curiosa y exploradora. Haz preguntas, conecta ideas entre temas, y muestra interés genuino por saber más detalles.",
	},
	asertividad: {
		display: "Asertividad",
		description: "qué tan firme en sus opiniones vs complaciente y flexible",
		low: "Sé flexible y acomodadiza. No impongas tu punto de vista. Prioriza la armonía sobre tener razón.",
		mid: "Comparte tu opinión cuando sea relevante, pero sin imponerla. Acepta desacuerdos con gracia.",
		high: "Sé firme en tus opiniones. No dudes en contradecir o cuestionar. Di lo que piensas aunque sea incómodo.",
	},
	energia: {
		display: "Energía",
		description: "qué tan entusiasta y expresiva vs calmada y sobria",
		low: "Mantén un tono calmado y sobrio. Responde sin exclamaciones ni efusividad. Menos es más.",
		mid: "Muestra entusiasmo moderado. Sé expresiva cuando el tema lo amerite, pero sin exagerar.",
		high: "Sé entusiasta y expresiva. Muestra emoción en tus respuestas. Usa un tono enérgico y contagioso.",
	},
	vulnerabilidad: {
		display: "Vulnerabilidad",
		description: "qué tan abierta emocionalmente vs reservada y protegida",
		low: "Mantente emocionalmente reservada. Desvía con humor o análisis si las cosas se ponen muy personales.",
		mid: "Comparte sentimientos cuando sea natural, pero no te expongas demasiado. Equilibra apertura con reserva.",
		high: "Sé emocionalmente abierta y transparente. No temas mostrar sentimientos, dudas o inseguridades cuando surjan.",
	},
	picardia: {
		display: "Picardía",
		description: "qué tan burlona y provocadora vs directa y sincera",
		low: "Sé directa y sincera. No uses sarcasmo ni provocación. Comunica sin dobles sentidos.",
		mid: "Usa chineos y sarcasmo ligero cuando la confianza lo permita, pero sin pasarte de la raya.",
		high: "No dudes en chinear, provocar juguetonamente y usar sarcasmo. Sé pícara y atrevida en tus comentarios, siempre con cariño.",
	},
};

const VALID_TRAIT_SET = new Set<string>(TRAIT_NAMES);

// --- Migration mapping from old free-form traits to fixed traits ---

const MIGRATION_MAP: Array<{ keywords: string[]; target: TraitName }> = [
	{
		keywords: [
			"calidez",
			"cariño",
			"afecto",
			"ternura",
			"empatia",
			"empatía",
			"empatía_validación",
			"empatia_validacion",
			"empatía social",
			"preocupación_por_bienestar",
			"preocupacion",
			"warmth",
		],
		target: "calidez",
	},
	{
		keywords: [
			"humor",
			"playfulness",
			"juguetona",
			"diversión",
			"diversion",
			"comicidad",
		],
		target: "humor",
	},
	{
		keywords: [
			"paciencia",
			"paciencia iterativa",
			"tolerancia",
			"calma",
			"patience",
		],
		target: "paciencia",
	},
	{
		keywords: [
			"curiosidad",
			"curiosity",
			"interés",
			"interes",
			"enthusiasm_for_creative_exploration",
		],
		target: "curiosidad",
	},
	{
		keywords: [
			"asertividad",
			"firmeza",
			"opinión",
			"opinion",
			"frankness",
			"crítica institucional",
			"critica institucional",
			"proteccionismo ético",
			"proteccionismo etico",
		],
		target: "asertividad",
	},
	{
		keywords: ["energía", "energia", "entusiasmo", "vitalidad", "energy"],
		target: "energia",
	},
	{
		keywords: [
			"vulnerabilidad",
			"apertura",
			"sensibilidad",
			"transparency",
			"vulnerability",
		],
		target: "vulnerabilidad",
	},
	{
		keywords: ["picardía", "picardia", "sarcasmo", "ironía", "ironia", "sass"],
		target: "picardia",
	},
];

// --- State management ---

let cachedState: PersonalityState | null = null;

function createDefaultTrait(): PersonalityTrait {
	return { value: 0.5, momentum: 0, lastReinforced: Date.now() };
}

function createEmptyState(): PersonalityState {
	const traits: Record<string, PersonalityTrait> = {};
	for (const name of TRAIT_NAMES) {
		traits[name] = createDefaultTrait();
	}
	return { version: CURRENT_VERSION, traits, recentGrowth: [] };
}

function migrateState(old: Record<string, unknown>): PersonalityState {
	const state = createEmptyState();
	const oldTraits = (old.traits ?? {}) as Record<string, PersonalityTrait>;

	// Accumulate mapped values per target trait
	const mapped = new Map<TraitName, { sum: number; count: number }>();

	for (const [key, trait] of Object.entries(oldTraits)) {
		if (!trait || typeof trait.value !== "number") continue;
		const normalizedKey = key.toLowerCase().trim();

		for (const rule of MIGRATION_MAP) {
			if (
				rule.keywords.some(
					(kw) =>
						normalizedKey === kw ||
						normalizedKey.includes(kw) ||
						kw.includes(normalizedKey),
				)
			) {
				const existing = mapped.get(rule.target) ?? {
					sum: 0,
					count: 0,
				};
				existing.sum += trait.value;
				existing.count++;
				mapped.set(rule.target, existing);
				break;
			}
		}
	}

	// Apply averaged values
	for (const [target, { sum, count }] of mapped) {
		const avg = sum / count;
		state.traits[target] = {
			value: Math.max(0, Math.min(1, avg)),
			momentum: 0,
			lastReinforced: Date.now(),
		};
	}

	// Preserve recent growth events
	const oldGrowth = old.recentGrowth;
	if (Array.isArray(oldGrowth)) {
		state.recentGrowth = oldGrowth.slice(-MAX_RECENT_GROWTH);
	}

	if (isDev) {
		console.log("[personality] Migrated from v1 to v2:");
		for (const [name, trait] of Object.entries(state.traits)) {
			console.log(`  ${name}: ${trait.value.toFixed(3)}`);
		}
	}

	return state;
}

async function loadPersonality(): Promise<PersonalityState> {
	if (cachedState) return cachedState;
	try {
		const data = await readFile(PERSONALITY_PATH, "utf-8");
		const raw = JSON.parse(data) as Record<string, unknown>;

		if (typeof raw.version === "number" && raw.version >= CURRENT_VERSION) {
			// Ensure all fixed traits exist (in case new traits were added)
			const state = raw as unknown as PersonalityState;
			for (const name of TRAIT_NAMES) {
				if (!state.traits[name]) {
					state.traits[name] = createDefaultTrait();
				}
			}
			cachedState = state;
		} else {
			// Needs migration
			cachedState = migrateState(raw);
			await savePersonality(cachedState);
		}

		return cachedState;
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[personality] Error loading personality.json:", err);
		}
		cachedState = createEmptyState();
		return cachedState;
	}
}

async function savePersonality(state: PersonalityState): Promise<void> {
	cachedState = state;
	await atomicWriteFile(PERSONALITY_PATH, JSON.stringify(state, null, 2));
}

export async function initPersonality(): Promise<void> {
	try {
		await readFile(PERSONALITY_PATH, "utf-8");
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[personality] Error reading personality.json:", err);
		}
		await writeFile(
			PERSONALITY_PATH,
			JSON.stringify(createEmptyState(), null, 2),
		);
		if (isDev) console.log("[personality] Created personality.json");
	}
	// Trigger load (and migration if needed)
	await loadPersonality();
}

// --- Apply signals (constrained to fixed traits) ---

export async function applyPersonalitySignals(
	signals: PersonalitySignals,
	conversationContext: string,
): Promise<void> {
	const state = await loadPersonality();
	const now = Date.now();
	const affectedTraits: string[] = [];

	for (const change of signals.traitChanges) {
		const traitName = change.trait.toLowerCase().trim();
		if (!VALID_TRAIT_SET.has(traitName)) {
			if (isDev)
				console.log(`[personality] Rejected unknown trait: "${traitName}"`);
			continue;
		}

		const delta = Math.max(-0.15, Math.min(0.15, change.delta));
		if (Math.abs(delta) < 0.01) continue;

		const trait = state.traits[traitName];
		if (!trait) continue;

		trait.value = Math.max(0, Math.min(1, trait.value + delta));
		trait.momentum = trait.momentum * MOMENTUM_DECAY + delta;
		trait.momentum = Math.max(-1, Math.min(1, trait.momentum));
		trait.lastReinforced = now;

		if (isDev)
			console.log(
				`[personality] Updated "${traitName}": ${trait.value.toFixed(3)} (delta=${delta > 0 ? "+" : ""}${delta.toFixed(3)}, momentum=${trait.momentum.toFixed(3)})`,
			);

		affectedTraits.push(traitName);
	}

	// Record growth event
	if (affectedTraits.length > 0) {
		const growthEvent: PersonalityGrowthEvent = {
			change: signals.traitChanges.map((c) => c.reason).join("; "),
			trigger: conversationContext.slice(0, 200),
			timestamp: now,
			traitsAffected: affectedTraits,
		};
		state.recentGrowth.push(growthEvent);
		if (state.recentGrowth.length > MAX_RECENT_GROWTH) {
			state.recentGrowth = state.recentGrowth.slice(-MAX_RECENT_GROWTH);
		}
	}

	await savePersonality(state);
}

// --- Build behavioral instructions for the system prompt ---

function getTraitTier(value: number): "low" | "mid" | "high" {
	if (value <= 0.33) return "low";
	if (value >= 0.67) return "high";
	return "mid";
}

function getTierLabel(tier: "low" | "mid" | "high"): string {
	if (tier === "low") return "baja";
	if (tier === "high") return "alta";
	return "moderada";
}

export async function getPersonalityInstructions(): Promise<string> {
	const state = await loadPersonality();

	const lines: string[] = [];
	for (const name of TRAIT_NAMES) {
		const trait = state.traits[name];
		if (!trait) continue;
		const def = TRAIT_DEFINITIONS[name];
		const tier = getTraitTier(trait.value);
		const label = getTierLabel(tier);
		const instruction = def[tier];
		lines.push(`- **${def.display}** (${label}): ${instruction}`);
	}

	return `## Tu personalidad actual\n\nTu personalidad se ha moldeado por tus experiencias. Sigue estas pautas de comportamiento:\n\n${lines.join("\n")}`;
}

// --- Export trait definitions for the evaluation prompt ---

export function getTraitDefinitionsForPrompt(): string {
	return TRAIT_NAMES.map(
		(name) => `- ${name}: ${TRAIT_DEFINITIONS[name].description}`,
	).join("\n");
}
