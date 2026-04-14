import { createUserContent, GoogleGenAI } from "@google/genai";
import { createChatProvider } from "../providers/index.ts";
import { withRetry } from "../utils.ts";

const isDev = process.env.NODE_ENV === "development";
const CLASSIFIER_MODEL = "gemini-flash-lite-latest";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}

let warnedClassifierFallback = false;

const CLASSIFIER_PROMPT = (caption: string) =>
	`The user attached an image and wrote this message: "${caption}"

Decide: is the user asking to EDIT, MODIFY, TRANSFORM, or GENERATE A NEW VERSION of the image? (vs. just commenting on it, asking a question about it, or sharing it)

Answer with a single word: "yes" or "no".`;

/**
 * Decide whether the caption expresses intent to edit/modify an attached image.
 * Uses Gemini Flash for a cheap, fast classification when GOOGLE_API_KEY is
 * available; otherwise falls back to the configured chat provider. Returns
 * null on failure so the caller can fall back to a regex heuristic.
 */
export async function classifyEditIntent(
	caption: string,
): Promise<boolean | null> {
	const trimmed = caption.trim();
	if (!trimmed) return false;

	const useGemini = !!process.env.GOOGLE_API_KEY;
	if (!useGemini && !warnedClassifierFallback) {
		warnedClassifierFallback = true;
		console.warn(
			"[classifyEditIntent] GOOGLE_API_KEY not set — falling back to the configured chat provider for edit-intent classification.",
		);
	}

	try {
		let text: string;
		if (useGemini) {
			const response = await withRetry(
				() =>
					getAI().models.generateContent({
						model: CLASSIFIER_MODEL,
						contents: createUserContent([CLASSIFIER_PROMPT(trimmed)]),
						config: {
							temperature: 0,
							maxOutputTokens: 5,
						},
					}),
				2,
				500,
			);
			text = (response.text ?? "").trim().toLowerCase();
		} else {
			const provider = createChatProvider();
			const raw = await withRetry(
				() =>
					provider.generateResponse("", [
						{ role: "user", content: CLASSIFIER_PROMPT(trimmed) },
					]),
				2,
				500,
			);
			text = raw.trim().toLowerCase();
		}

		if (isDev) console.log(`[classifyEditIntent] "${trimmed}" → ${text}`);
		if (text.startsWith("yes")) return true;
		if (text.startsWith("no")) return false;
		return null;
	} catch (error) {
		console.error("[classifyEditIntent] Error:", error);
		return null;
	}
}

// Spanish heuristic: matches user-language content (users typically write in Spanish).
const FOLLOW_UP_INTENT_PATTERNS = [
	/\b(voy a|iré a|vamos a|tengo que|me toca|tengo una?)\b/i,
	/\b(esta noche|mañana|esta tarde|hoy|el lunes|el martes|el miércoles|el jueves|el viernes|el sábado|el domingo|este fin de semana)\b/i,
	/\b(cita|reunión|entrevista|examen|viaje|cine|película|doctor|fiesta|concierto|clase|gym|gimnasio|salón|peluquería)\b/i,
	/\b(a las \d{1,2}|pm|am)\b/i,
];

export function hasFollowUpIntent(text: string): boolean {
	let matchCount = 0;
	for (const pattern of FOLLOW_UP_INTENT_PATTERNS) {
		if (pattern.test(text)) matchCount++;
	}
	// Require at least 2 pattern matches to reduce false positives
	return matchCount >= 2;
}
