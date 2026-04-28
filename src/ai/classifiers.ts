import { createUserContent, GoogleGenAI } from "@google/genai";
import { createChatProvider } from "../providers/index.ts";
import type { ConversationMessage } from "../types.ts";
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

export interface GroupMessageIntentInput {
	mode: "spontaneous" | "continuation";
	botName: string;
	currentSpeaker: string;
	currentMessage: string;
	recentMessages: ConversationMessage[];
	lastBotMessage?: string;
}

export type GroupMessageIntentDecision = "respond" | "silence";

function formatGroupMessageForClassifier(message: ConversationMessage): string {
	const speaker =
		message.role === "model" ? "Bot" : (message.name ?? "Group member");
	return `${speaker}: ${message.content}`;
}

function buildGroupMessageIntentPrompt(input: GroupMessageIntentInput): string {
	const recent = input.recentMessages
		.slice(-6)
		.map(formatGroupMessageForClassifier)
		.join("\n");
	const lastBotMessage = input.lastBotMessage?.trim()
		? input.lastBotMessage.trim()
		: "(none)";

	return `You are a lightweight multilingual router for a Telegram group chat bot named ${input.botName}.

Your job is NOT to write the bot's reply. Decide only whether the bot should be allowed to generate a reply.

Mode: ${input.mode}

Decision rules:
- Return "respond" only when the bot's participation would feel natural in a group chat.
- Return "silence" when responding would feel intrusive, attention-seeking, repetitive, or like the group moved on.
- Be conservative. If uncertain, return "silence".
- This must work across languages. Do not rely on language-specific keywords.

Mode-specific guidance:
- spontaneous: The bot has not been directly addressed. Allow a reply only if the latest message creates a clear opening where a normal group member could add value.
- continuation: The bot recently spoke. Allow a reply only if the latest message likely engages with the bot's last message or asks the bot to continue. If it is just members talking among themselves, choose silence.

Recent chat:
${recent || "(no recent chat)"}

Bot's last message:
${lastBotMessage}

Latest message:
${input.currentSpeaker}: ${input.currentMessage}

Answer with exactly one word: respond or silence.`;
}

async function runSingleWordClassifier(
	prompt: string,
	maxOutputTokens: number,
): Promise<string> {
	const useGemini = !!process.env.GOOGLE_API_KEY;
	if (useGemini) {
		const response = await withRetry(
			() =>
				getAI().models.generateContent({
					model: CLASSIFIER_MODEL,
					contents: createUserContent([prompt]),
					config: {
						temperature: 0,
						maxOutputTokens,
					},
				}),
			2,
			500,
		);
		return response.text ?? "";
	}

	const provider = createChatProvider();
	return await withRetry(
		() => provider.generateResponse("", [{ role: "user", content: prompt }]),
		2,
		500,
	);
}

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
		const text = (await runSingleWordClassifier(CLASSIFIER_PROMPT(trimmed), 5))
			.trim()
			.toLowerCase();

		if (isDev) console.log(`[classifyEditIntent] "${trimmed}" → ${text}`);
		if (text.startsWith("yes")) return true;
		if (text.startsWith("no")) return false;
		return null;
	} catch (error) {
		console.error("[classifyEditIntent] Error:", error);
		return null;
	}
}

/**
 * Lightweight multilingual gate for group participation. This intentionally
 * receives only the recent chat slice and never loads long-term memory.
 */
export async function classifyGroupMessageIntent(
	input: GroupMessageIntentInput,
): Promise<GroupMessageIntentDecision | null> {
	const currentMessage = input.currentMessage.trim();
	if (!currentMessage) return "silence";

	const useGemini = !!process.env.GOOGLE_API_KEY;
	if (!useGemini && !warnedClassifierFallback) {
		warnedClassifierFallback = true;
		console.warn(
			"[classifyGroupMessageIntent] GOOGLE_API_KEY not set — falling back to the configured chat provider for group-intent classification.",
		);
	}

	try {
		const prompt = buildGroupMessageIntentPrompt(input);
		const text = (await runSingleWordClassifier(prompt, 8))
			.trim()
			.toLowerCase()
			.replace(/[`"'.,:;!]/g, "");

		if (isDev) {
			console.log(
				`[classifyGroupMessageIntent] ${input.mode} "${currentMessage}" → ${text}`,
			);
		}
		if (text.startsWith("respond")) return "respond";
		if (text.startsWith("silence")) return "silence";
		return null;
	} catch (error) {
		console.error("[classifyGroupMessageIntent] Error:", error);
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
