import { createUserContent, GoogleGenAI } from "@google/genai";
import { createChatProvider } from "../providers/index.ts";
import type { ConversationMessage } from "../types.ts";
import { withRetry } from "../utils.ts";

const isDev = process.env.NODE_ENV === "development";
const CLASSIFIER_MODEL = "gemini-flash-lite-latest";
const GROUP_ROUTER_MAX_MESSAGES = 6;
const GROUP_ROUTER_MAX_MESSAGE_CHARS = 500;
const GROUP_ROUTER_MAX_TOTAL_CHARS = 3000;

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
	mode: "name" | "spontaneous" | "continuation";
	botName: string;
	currentSpeaker: string;
	currentMessage: string;
	recentMessages: ConversationMessage[];
	lastBotMessage?: string;
}

export type GroupMessageIntentDecision = "respond" | "silence";
export type GroupSocialAddressing =
	| "direct"
	| "about_bot"
	| "continuation"
	| "ambient";
export type GroupSocialAction = "respond" | "silence";

export interface GroupSocialDecision {
	addressing: GroupSocialAddressing;
	action: GroupSocialAction;
	confidence: number;
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 12).trimEnd()} [truncated]`;
}

function formatGroupMessageForClassifier(message: ConversationMessage): string {
	const speaker =
		message.role === "model" ? "Bot" : (message.name ?? "Group member");
	return `${speaker}: ${truncateText(message.content, GROUP_ROUTER_MAX_MESSAGE_CHARS)}`;
}

function formatRecentGroupMessages(messages: ConversationMessage[]): string {
	const lines = messages
		.slice(-GROUP_ROUTER_MAX_MESSAGES)
		.map(formatGroupMessageForClassifier);
	let totalChars = 0;
	const bounded: string[] = [];

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		const nextTotal = totalChars + line.length + 1;
		if (nextTotal > GROUP_ROUTER_MAX_TOTAL_CHARS) break;
		bounded.unshift(line);
		totalChars = nextTotal;
	}

	return bounded.join("\n");
}

function buildGroupMessageIntentPrompt(input: GroupMessageIntentInput): string {
	const recent = formatRecentGroupMessages(input.recentMessages);
	const lastBotMessage = input.lastBotMessage?.trim()
		? truncateText(input.lastBotMessage.trim(), GROUP_ROUTER_MAX_MESSAGE_CHARS)
		: "(none)";
	const currentMessage = truncateText(
		input.currentMessage,
		GROUP_ROUTER_MAX_MESSAGE_CHARS,
	);

	return `You are a lightweight multilingual router for a Telegram group chat bot named ${input.botName}.

Your job is NOT to write the bot's reply. Decide only how the latest group message relates socially to the bot, and whether the bot should be allowed to generate a reply.

Mode: ${input.mode}

Addressing labels:
- direct: The latest message speaks to the bot, asks the bot a question, gives the bot an instruction, greets the bot, or clearly invites the bot to answer.
- about_bot: The latest message mentions the bot as a topic, joke, complaint, or aside, but is not speaking to the bot.
- continuation: The bot recently spoke and the latest message likely engages with that bot message or asks the bot to continue.
- ambient: Group members are talking among themselves; the bot is not socially addressed.

Action rules:
- action "respond" only when the bot's participation would feel natural in a group chat.
- action "silence" when responding would feel intrusive, attention-seeking, repetitive, or like the group moved on.
- Be conservative. If uncertain, return "silence".
- Mentioning the bot's name is not enough. Distinguish talking TO the bot from talking ABOUT the bot.
- This must work across languages. Do not rely on language-specific keywords.

Mode-specific guidance:
- name: The latest message contains the bot's name. Classify whether it is direct, about_bot, continuation, or ambient.
- spontaneous: The bot has not been directly addressed. Allow a reply only if the latest message creates a clear opening where a normal group member could add value.
- continuation: The bot recently spoke. Allow a reply when the latest message likely engages with the bot's last message, answers a question the bot asked, shares a reciprocal status/activity after the bot shared one, or asks the bot to continue. If it is just members talking among themselves, choose silence.

Recent chat:
${recent || "(no recent chat)"}

Bot's last message:
${lastBotMessage}

Latest message:
${input.currentSpeaker}: ${currentMessage}

Return ONLY compact JSON with this exact shape:
{"addressing":"direct|about_bot|continuation|ambient","action":"respond|silence","confidence":0.0}`;
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

function parseGroupSocialDecision(text: string): GroupSocialDecision | null {
	const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) return null;

	try {
		const parsed = JSON.parse(jsonText) as Partial<GroupSocialDecision>;
		const addressingValues = new Set<GroupSocialAddressing>([
			"direct",
			"about_bot",
			"continuation",
			"ambient",
		]);
		const actionValues = new Set<GroupSocialAction>(["respond", "silence"]);
		const addressing = parsed.addressing;
		const action = parsed.action;
		if (!addressing || !addressingValues.has(addressing)) return null;
		if (!action || !actionValues.has(action)) return null;
		const confidence =
			typeof parsed.confidence === "number" &&
			Number.isFinite(parsed.confidence)
				? Math.max(0, Math.min(1, parsed.confidence))
				: 0.5;

		return { addressing, action, confidence };
	} catch {
		return null;
	}
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
	const decision = await classifyGroupSocialIntent(input);
	return decision?.action ?? null;
}

/**
 * Bounded social router for group participation. It intentionally sends only
 * a small recent chat slice, the latest message, and the last bot message.
 */
export async function classifyGroupSocialIntent(
	input: GroupMessageIntentInput,
): Promise<GroupSocialDecision | null> {
	const currentMessage = input.currentMessage.trim();
	if (!currentMessage) {
		return { addressing: "ambient", action: "silence", confidence: 1 };
	}

	const useGemini = !!process.env.GOOGLE_API_KEY;
	if (!useGemini && !warnedClassifierFallback) {
		warnedClassifierFallback = true;
		console.warn(
			"[classifyGroupMessageIntent] GOOGLE_API_KEY not set — falling back to the configured chat provider for group-intent classification.",
		);
	}

	try {
		const prompt = buildGroupMessageIntentPrompt(input);
		const text = await runSingleWordClassifier(prompt, 80);
		const decision = parseGroupSocialDecision(text);

		if (isDev) {
			console.log(
				`[classifyGroupSocialIntent] ${input.mode} "${currentMessage}" → ${text.trim()}`,
			);
		}
		return decision;
	} catch (error) {
		console.error("[classifyGroupSocialIntent] Error:", error);
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
