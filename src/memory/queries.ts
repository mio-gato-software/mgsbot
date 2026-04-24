import { generateEmbedding } from "../embeddings.ts";
import type { ConversationMessage } from "../types.ts";

export function normalizeName(name: string): string {
	return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.split(/\s+/)
			.filter((t) => t.length > 1),
	);
}

/**
 * Compute keyword overlap score between query and candidate text.
 * Returns 0–1: fraction of query tokens found in candidate.
 */
export function computeTextScore(query: string, candidate: string): number {
	const queryTokens = tokenize(query);
	if (queryTokens.size === 0) return 0;
	const candidateTokens = tokenize(candidate);
	let matches = 0;
	for (const token of queryTokens) {
		if (candidateTokens.has(token)) matches++;
	}
	return matches / queryTokens.size;
}

// --- Heuristic Pre-filter ---

const SIGNIFICANT_PATTERNS = [
	// Personal declarations (Spanish)
	/\b(soy|trabajo en|me gusta|tengo|vivo en|estudio|naci)\b/i,
	// Activity / movement / state — short phrases like "voy de viaje", "estoy en casa",
	// "salí pa' la calle". These describe what the user is doing right now, which the
	// episode summary needs to capture even if no durable fact gets extracted.
	/\b(voy|vamos|fui|fuimos|sal[ií]|estoy|estamos|ando|andamos|llegu[eé]|llegamos|vine|vinimos|regres[eé]|regresamos|me voy|nos vamos|estar[eé]|estaremos|viaje|viajando|carretera|guagua|carro|guiando|manejando|conduciendo|trabajando|reuni[oó]n|cita)\b/i,
	// Future plans / intent
	/\b(voy a|vamos a|tengo que|tenemos que|pienso|planeo|planeamos|quiero|queremos|me toca|nos toca|para ma[ñn]ana|esta noche|el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\b/i,
	// Dates and events
	/\b\d{1,2}\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i,
	// Memory references
	/\b(recuerdas?|te cont[eé]|te dije|ya te|mencion[eé])\b/i,
	// Names (capitalized words after common intro patterns)
	/\b(se llama|mi (hijo|hija|esposo|esposa|novio|novia|amigo|amiga|hermano|hermana|padre|madre|jefe)|soy)\s+[A-Z]/,
	// Numbers that could be ages, dates, amounts
	/\b\d{2,4}\s*(años|año)\b/i,
	// Durations like "4 horas", "2 dias", "una semana"
	/\b\d{1,3}\s*(hora|horas|d[ií]a|d[ií]as|semana|semanas|mes|meses)\b/i,
];

const MIN_SIGNIFICANT_LENGTH = 60;

export function hasSignificantContent(
	messages: ConversationMessage[],
): boolean {
	for (const msg of messages) {
		// Long messages are often significant
		if (msg.content.length > MIN_SIGNIFICANT_LENGTH) return true;

		// Check for significant patterns
		for (const pattern of SIGNIFICANT_PATTERNS) {
			if (pattern.test(msg.content)) return true;
		}
	}
	return false;
}

/**
 * Generate a query embedding from recent messages for retrieval.
 * Returns the embedding and the raw text used (for hybrid keyword scoring).
 */
export async function getQueryEmbedding(
	messages: ConversationMessage[],
): Promise<{ embedding: number[]; text: string }> {
	const recentText = messages
		.slice(-3)
		.map((m) => m.content)
		.join(" ");
	const embedding = await generateEmbedding(recentText);
	return { embedding, text: recentText };
}
