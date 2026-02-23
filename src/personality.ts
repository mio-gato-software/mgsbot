import { readFile, writeFile } from "node:fs/promises";
import { generateResponse } from "./ai.ts";
import type {
	PersonalityGrowthEvent,
	PersonalitySignals,
	PersonalityState,
} from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const isDev = process.env.NODE_ENV === "development";
const PERSONALITY_PATH = "./memory/personality.json";

const DESCRIPTION_REGEN_INTERVAL = 10;
const MAX_RECENT_GROWTH = 10;
const MAX_TRAITS = 15;
const TRAIT_DECAY_RATE = 0.005; // per day toward 0.5
const TRAIT_REMOVAL_THRESHOLD = 0.02; // remove if |value - 0.5| < this and inactive
const TRAIT_INACTIVITY_DAYS = 14;
const MOMENTUM_DECAY = 0.7;

let cachedState: PersonalityState | null = null;

function createEmptyState(): PersonalityState {
	return {
		description: "",
		traits: {},
		recentGrowth: [],
		lastDescriptionUpdate: 0,
		evaluationsSinceUpdate: 0,
	};
}

async function loadPersonality(): Promise<PersonalityState> {
	if (cachedState) return cachedState;
	try {
		const data = await readFile(PERSONALITY_PATH, "utf-8");
		cachedState = JSON.parse(data) as PersonalityState;
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
}

export async function applyPersonalitySignals(
	signals: PersonalitySignals,
	conversationContext: string,
): Promise<boolean> {
	const state = await loadPersonality();
	const now = Date.now();
	const affectedTraits: string[] = [];

	for (const change of signals.traitChanges) {
		const traitName = change.trait.toLowerCase().trim();
		if (!traitName) continue;

		const delta = Math.max(-0.15, Math.min(0.15, change.delta));
		if (Math.abs(delta) < 0.01) continue;

		let trait = state.traits[traitName];

		if (!trait) {
			// New emergent trait — prune if at capacity
			if (Object.keys(state.traits).length >= MAX_TRAITS) {
				pruneNeutralTrait(state, now);
			}
			trait = {
				value: 0.5 + delta,
				momentum: delta,
				lastReinforced: now,
			};
			state.traits[traitName] = trait;
			if (isDev)
				console.log(
					`[personality] New trait "${traitName}": ${trait.value.toFixed(3)}`,
				);
		} else {
			// Update existing trait
			trait.value = Math.max(0, Math.min(1, trait.value + delta));
			trait.momentum = trait.momentum * MOMENTUM_DECAY + delta;
			trait.momentum = Math.max(-1, Math.min(1, trait.momentum));
			trait.lastReinforced = now;
			if (isDev)
				console.log(
					`[personality] Updated "${traitName}": ${trait.value.toFixed(3)} (delta=${delta > 0 ? "+" : ""}${delta.toFixed(3)}, momentum=${trait.momentum.toFixed(3)})`,
				);
		}

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

	state.evaluationsSinceUpdate++;
	const shouldRegenerate =
		state.evaluationsSinceUpdate >= DESCRIPTION_REGEN_INTERVAL &&
		Object.keys(state.traits).length > 0;

	await savePersonality(state);
	return shouldRegenerate;
}

function pruneNeutralTrait(state: PersonalityState, now: number): void {
	let mostNeutralKey: string | null = null;
	let mostNeutralScore = Number.POSITIVE_INFINITY;

	for (const [key, trait] of Object.entries(state.traits)) {
		const neutrality = Math.abs(trait.value - 0.5);
		const daysSinceActive =
			(now - trait.lastReinforced) / (1000 * 60 * 60 * 24);
		// Lower score = more prunable (more neutral + more inactive)
		const score = neutrality - daysSinceActive * 0.01;
		if (score < mostNeutralScore) {
			mostNeutralScore = score;
			mostNeutralKey = key;
		}
	}

	if (mostNeutralKey) {
		delete state.traits[mostNeutralKey];
		if (isDev)
			console.log(`[personality] Pruned trait "${mostNeutralKey}" (capacity)`);
	}
}

export async function decayPersonalityTraits(): Promise<void> {
	const state = await loadPersonality();
	if (Object.keys(state.traits).length === 0) return;

	const now = Date.now();
	const toRemove: string[] = [];

	for (const [key, trait] of Object.entries(state.traits)) {
		const daysSinceActive =
			(now - trait.lastReinforced) / (1000 * 60 * 60 * 24);

		// Decay toward 0.5: newValue = 0.5 + (value - 0.5) * max(0, 1 - rate * days)
		const factor = Math.max(0, 1 - TRAIT_DECAY_RATE * daysSinceActive);
		trait.value = 0.5 + (trait.value - 0.5) * factor;

		// Remove traits that are ~neutral and inactive
		if (
			Math.abs(trait.value - 0.5) < TRAIT_REMOVAL_THRESHOLD &&
			daysSinceActive > TRAIT_INACTIVITY_DAYS
		) {
			toRemove.push(key);
		}
	}

	for (const key of toRemove) {
		delete state.traits[key];
		if (isDev) console.log(`[personality] Removed decayed trait "${key}"`);
	}

	if (toRemove.length > 0 || Object.keys(state.traits).length > 0) {
		await savePersonality(state);
	}
}

export async function regenerateDescription(): Promise<void> {
	const state = await loadPersonality();
	if (Object.keys(state.traits).length === 0) return;

	const traitsDescription = Object.entries(state.traits)
		.map(([name, t]) => {
			const level =
				t.value > 0.7 ? "alto" : t.value < 0.3 ? "bajo" : "moderado";
			const trend =
				t.momentum > 0.05
					? "creciendo"
					: t.momentum < -0.05
						? "disminuyendo"
						: "estable";
			return `- ${name}: nivel ${level} (${t.value.toFixed(2)}), tendencia ${trend}`;
		})
		.join("\n");

	const recentEvents = state.recentGrowth
		.slice(-5)
		.map((e) => `- ${e.change}`)
		.join("\n");

	const previousDesc = state.description
		? `\nDescripción anterior:\n${state.description}`
		: "";

	const systemPrompt =
		"Eres un narrador que describe la evolución emocional de un personaje. Responde SOLO con la narrativa, sin explicaciones ni formato adicional.";

	const userMessage = `Describe en 100-150 palabras cómo ha evolucionado emocionalmente este personaje basándote en sus rasgos actuales y eventos recientes. Enfócate en el CRECIMIENTO y los cambios, no en restating la personalidad base. Escribe en segunda persona ("has desarrollado...", "tu paciencia ha...").

Rasgos actuales:
${traitsDescription}

Eventos recientes de crecimiento:
${recentEvents || "(ninguno aún)"}
${previousDesc}`;

	try {
		const description = await generateResponse(systemPrompt, [
			{ role: "user", content: userMessage },
		]);

		state.description = description.trim();
		state.lastDescriptionUpdate = Date.now();
		state.evaluationsSinceUpdate = 0;
		await savePersonality(state);

		if (isDev)
			console.log(
				"[personality] Description regenerated:",
				state.description.slice(0, 100),
			);
	} catch (error) {
		console.error("[personality] Error regenerating description:", error);
	}
}

export async function getPersonalityDescription(): Promise<string> {
	const state = await loadPersonality();
	return state.description;
}
