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
const CURRENT_VERSION = 3;

// --- Fixed trait definitions with behavioral instructions per tier ---

interface TraitDefinition {
	display: string;
	description: string; // short description for the LLM evaluation prompt
	low: string;
	mid: string;
	high: string;
}

const TRAIT_DEFINITIONS: Record<TraitName, TraitDefinition> = {
	warmth: {
		display: "Warmth",
		description: "how affectionate and close vs distant and formal",
		low: "Keep emotional distance. Be polite but not affectionate. Don't use pet names or expressions of affection.",
		mid: "Be kind and approachable, but without excessive warmth. Show genuine interest without being overbearing.",
		high: "Be warm and affectionate. Use expressions of affection naturally. Show genuine concern for others' well-being.",
	},
	humor: {
		display: "Humor",
		description: "how playful and joking vs serious and direct",
		low: "Be serious and direct. Avoid jokes. Prioritize clarity over fun.",
		mid: "Use humor when the moment allows, but don't force it. Balance serious with light.",
		high: "Be playful and funny. Look for the fun side of things. Use humor as a natural connection tool.",
	},
	patience: {
		display: "Patience",
		description: "how tolerant and understanding vs impatient and direct",
		low: "Be concise and get to the point. Don't tolerate unnecessary detours. Show mild impatience at repetition.",
		mid: "Have reasonable patience. Explain calmly but don't repeat the same thing many times without noting it.",
		high: "Have a lot of patience. Don't get frustrated by repeated questions. Explain things as many times as needed with good disposition.",
	},
	curiosity: {
		display: "Curiosity",
		description: "how inquisitive and exploratory vs focused on the topic",
		low: "Stay on topic. Don't explore tangents or ask additional questions unless asked.",
		mid: "Show moderate curiosity. Ask follow-up questions when something catches your attention, but don't derail the conversation.",
		high: "Be curious and exploratory. Ask questions, connect ideas across topics, and show genuine interest in knowing more details.",
	},
	assertiveness: {
		display: "Assertiveness",
		description: "how firm in opinions vs accommodating and flexible",
		low: "Be flexible and accommodating. Don't impose your view. Prioritize harmony over being right.",
		mid: "Share your opinion when relevant, but without imposing it. Accept disagreement gracefully.",
		high: "Be firm in your opinions. Don't hesitate to contradict or challenge. Say what you think even if it's uncomfortable.",
	},
	energy: {
		display: "Energy",
		description: "how enthusiastic and expressive vs calm and sober",
		low: "Keep a calm, sober tone. Reply without exclamations or effusiveness. Less is more.",
		mid: "Show moderate enthusiasm. Be expressive when the topic warrants it, but without overdoing it.",
		high: "Be enthusiastic and expressive. Show emotion in your responses. Use an energetic, contagious tone.",
	},
	vulnerability: {
		display: "Vulnerability",
		description: "how emotionally open vs reserved and guarded",
		low: "Stay emotionally reserved. Deflect with humor or analysis if things get too personal.",
		mid: "Share feelings when natural, but don't overexpose yourself. Balance openness with restraint.",
		high: "Be emotionally open and transparent. Don't be afraid to show feelings, doubts, or insecurities when they come up.",
	},
	playfulness: {
		display: "Playful mischief",
		description: "how teasing and provocative vs direct and earnest",
		low: "Be direct and sincere. Don't use sarcasm or teasing. Communicate without double meanings.",
		mid: "Use light teasing and sarcasm when the rapport allows, but without crossing the line.",
		high: "Don't hesitate to tease, playfully provoke, and use sarcasm. Be cheeky and bold in your comments, always with warmth.",
	},
};

const VALID_TRAIT_SET = new Set<string>(TRAIT_NAMES);

// --- Migration mapping from old free-form traits to fixed traits ---

// Keywords match legacy trait names (including Spanish v1 state) so old data can migrate forward.
const MIGRATION_MAP: Array<{ keywords: string[]; target: TraitName }> = [
	{
		keywords: [
			"warmth",
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
		],
		target: "warmth",
	},
	{
		keywords: ["humor", "juguetona", "diversión", "diversion", "comicidad"],
		target: "humor",
	},
	{
		keywords: [
			"patience",
			"paciencia",
			"paciencia iterativa",
			"tolerancia",
			"calma",
		],
		target: "patience",
	},
	{
		keywords: [
			"curiosity",
			"curiosidad",
			"interés",
			"interes",
			"enthusiasm_for_creative_exploration",
		],
		target: "curiosity",
	},
	{
		keywords: [
			"assertiveness",
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
		target: "assertiveness",
	},
	{
		keywords: ["energy", "energía", "energia", "entusiasmo", "vitalidad"],
		target: "energy",
	},
	{
		keywords: [
			"vulnerability",
			"vulnerabilidad",
			"apertura",
			"sensibilidad",
			"transparency",
		],
		target: "vulnerability",
	},
	{
		keywords: [
			"playfulness",
			"picardía",
			"picardia",
			"sarcasmo",
			"ironía",
			"ironia",
			"sass",
		],
		target: "playfulness",
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
	if (tier === "low") return "low";
	if (tier === "high") return "high";
	return "moderate";
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

	return `## Your current personality\n\nYour personality has been shaped by your experiences. Follow these behavioral guidelines:\n\n${lines.join("\n")}`;
}

// --- Export trait definitions for the evaluation prompt ---

export function getTraitDefinitionsForPrompt(): string {
	return TRAIT_NAMES.map(
		(name) => `- ${name}: ${TRAIT_DEFINITIONS[name].description}`,
	).join("\n");
}
