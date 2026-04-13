import * as fs from "node:fs";
import {
	createPartFromUri,
	createUserContent,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import { getTraitDefinitionsForPrompt } from "./personality.ts";
import { type ChatMessage, createChatProvider } from "./providers/index.ts";
import { supportsVision } from "./providers/types.ts";
import { isTutorActive } from "./tutor.ts";
import type { PromotionResult } from "./types.ts";
import { withRetry } from "./utils.ts";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}
const MODEL = "gemini-3-flash-preview";
const CLASSIFIER_MODEL = "gemini-flash-lite-latest";

const isDev = process.env.NODE_ENV === "development";

function logTokenUsage(label: string, response: GenerateContentResponse): void {
	const usage = response.usageMetadata;
	if (!usage) return;
	console.log(
		`[tokens:${label}] in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`,
	);
}

const sttProvider = process.env.STT_PROVIDER?.toLowerCase();
const useFalSTT = sttProvider === "fal" && !!process.env.FAL_API_KEY;
const useLemonFoxSTT =
	!useFalSTT && !!process.env.LEMON_FOX_API_KEY && sttProvider !== "gemini";

async function transcribeWithLemonFox(filePath: string): Promise<string> {
	if (isDev) console.log("[transcribeAudio] Using LemonFox STT");

	const fileBuffer = await Bun.file(filePath).arrayBuffer();
	const fileName = filePath.split("/").pop() ?? "audio.ogg";

	const body = new FormData();
	body.append("file", new Blob([fileBuffer]), fileName);
	body.append("response_format", "json");
	if (isTutorActive()) {
		body.append("language", "en");
	}

	const response = await fetch(
		"https://api.lemonfox.ai/v1/audio/transcriptions",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.LEMON_FOX_API_KEY}`,
			},
			body,
			signal: AbortSignal.timeout(30_000),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		throw new Error(`LemonFox STT failed: ${response.status} ${errorBody}`);
	}

	const data = (await response.json()) as { text?: string };
	const text = data.text?.trim();
	if (!text) throw new Error("LemonFox STT returned empty text");
	if (isDev) console.log("[transcribeAudio] Result:", text.slice(0, 200));
	return text;
}

async function transcribeWithFal(
	filePath: string,
	mimeType: string,
): Promise<string> {
	if (isDev) console.log("[transcribeAudio] Using fal.ai Scribe v2 STT");

	const fileBuffer = await Bun.file(filePath).arrayBuffer();
	const base64Data = Buffer.from(fileBuffer).toString("base64");
	const audioUrl = `data:${mimeType};base64,${base64Data}`;

	const body: Record<string, unknown> = {
		audio_url: audioUrl,
		diarize: false,
		tag_audio_events: false,
	};

	if (isTutorActive()) {
		body.language_code = "eng";
	}

	const response = await fetch(
		"https://fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2",
		{
			method: "POST",
			headers: {
				Authorization: `Key ${process.env.FAL_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		throw new Error(`fal.ai STT failed: ${response.status} ${errorBody}`);
	}

	const data = (await response.json()) as { text?: string };
	const text = data.text?.trim();
	if (!text) throw new Error("fal.ai STT returned empty text");
	if (isDev) console.log("[transcribeAudio] Result:", text.slice(0, 200));
	return text;
}

async function transcribeWithGemini(
	filePath: string,
	mimeType: string,
): Promise<string> {
	if (isDev) console.log("[transcribeAudio] Using Gemini STT");

	const uploaded = await getAI().files.upload({
		file: filePath,
		config: { mimeType },
	});

	if (isDev) {
		console.log("[transcribeAudio] Upload result:", {
			name: uploaded.name,
			uri: uploaded.uri,
			state: uploaded.state,
			mimeType: uploaded.mimeType,
		});
	}

	// Poll until the file is ACTIVE (processing can take a few seconds)
	const MAX_POLL_ATTEMPTS = 20;
	const POLL_INTERVAL_MS = 1000;
	let fileState = uploaded.state;

	for (let i = 0; i < MAX_POLL_ATTEMPTS && fileState === "PROCESSING"; i++) {
		if (isDev)
			console.log(
				`[transcribeAudio] Polling file state (${i + 1}/${MAX_POLL_ATTEMPTS})...`,
			);
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		const fileInfo = await getAI().files.get({ name: uploaded.name ?? "" });
		fileState = fileInfo.state;
	}

	if (fileState !== "ACTIVE") {
		console.error(
			`[transcribeAudio] File never became ACTIVE (state: ${fileState})`,
		);
		return "[transcription failed]";
	}

	if (isDev)
		console.log(
			"[transcribeAudio] File is ACTIVE, generating transcription...",
		);

	const response = await getAI().models.generateContent({
		model: MODEL,
		contents: createUserContent([
			createPartFromUri(uploaded.uri ?? "", uploaded.mimeType ?? ""),
			isTutorActive()
				? "Transcribe this audio exactly as spoken. The speaker is practicing English, so the audio is most likely in English. Return ONLY the transcription, nothing else."
				: "Transcribe this audio exactly as spoken, in the original language. Return ONLY the transcription, nothing else.",
		]),
	});

	logTokenUsage("transcribeAudio", response);
	const text = response.text ?? "[transcription failed]";
	if (isDev) console.log("[transcribeAudio] Result:", text.slice(0, 200));
	return text;
}

export async function transcribeAudio(
	filePath: string,
	mimeType: string,
): Promise<string> {
	try {
		if (useFalSTT) {
			return await transcribeWithFal(filePath, mimeType);
		}
		if (useLemonFoxSTT) {
			return await transcribeWithLemonFox(filePath);
		}
		return await transcribeWithGemini(filePath, mimeType);
	} catch (error) {
		console.error("[transcribeAudio] Error:", error);
		return "[transcription failed]";
	}
}

export async function describeImage(
	filePath: string,
	mimeType: string,
	caption?: string,
): Promise<string> {
	try {
		const base64Data = fs.readFileSync(filePath, { encoding: "base64" });

		const provider = createChatProvider();
		if (supportsVision(provider)) {
			if (isDev)
				console.log(
					`[describeImage] Using provider: ${provider.name} (${provider.model})`,
				);
			try {
				return await provider.describeImage(base64Data, mimeType, caption);
			} catch (error) {
				console.error(
					`[describeImage] Provider ${provider.name} failed, falling back to Gemini:`,
					error,
				);
			}
		}

		if (isDev) console.log("[describeImage] Using Gemini, mimeType:", mimeType);

		const parts: Part[] = [
			{ inlineData: { mimeType, data: base64Data } },
			{
				text: caption
					? `The user sent this image with the caption: "${caption}". Describe what you see briefly so you can reference it in conversation.`
					: "The user sent this image. Describe what you see briefly so you can reference it in conversation.",
			},
		];

		const response = await withRetry(() =>
			getAI().models.generateContent({
				model: MODEL,
				contents: createUserContent(parts),
			}),
		);

		logTokenUsage("describeImage", response);
		const text = response.text ?? "[image description failed]";
		if (isDev) console.log("[describeImage] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		console.error("[describeImage] Error:", error);
		return "[image description failed]";
	}
}

const CLASSIFIER_PROMPT = (caption: string) =>
	`The user attached an image and wrote this message: "${caption}"

Decide: is the user asking to EDIT, MODIFY, TRANSFORM, or GENERATE A NEW VERSION of the image? (vs. just commenting on it, asking a question about it, or sharing it)

Answer with a single word: "yes" or "no".`;

let warnedClassifierFallback = false;

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

export async function analyzeYouTube(
	videoUrl: string,
	userQuestion?: string,
): Promise<string> {
	try {
		const prompt = userQuestion
			? `The user shared this YouTube video and said: "${userQuestion}". Watch the video and respond to what they said.`
			: "The user shared this YouTube video. Briefly describe what the video is about in the user's language so you can reference it in conversation.";

		const parts: Part[] = [
			{ fileData: { fileUri: videoUrl } },
			{ text: prompt },
		];

		if (isDev) console.log("[analyzeYouTube] URL:", videoUrl);

		const response = await getAI().models.generateContent({
			model: MODEL,
			contents: createUserContent(parts),
		});

		logTokenUsage("analyzeYouTube", response);
		const text = response.text ?? "[video analysis failed]";
		if (isDev) console.log("[analyzeYouTube] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		console.error("[analyzeYouTube] Error:", error);
		return "[video analysis failed]";
	}
}

export async function generateResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	const provider = createChatProvider();
	return provider.generateResponse(systemPrompt, messages);
}

export async function summarizeConversation(
	conversationText: string,
	existingEpisodes?: string[],
): Promise<string> {
	const context = existingEpisodes?.length
		? `Previous episode summaries:\n${existingEpisodes.map((e) => `- ${e}`).join("\n")}\n\n`
		: "";

	const systemPrompt =
		"You are a summarizer. Create a concise summary of the conversation, preserving key facts, decisions, and context. Keep it under 150 words.";
	const userMessage = `${context}Conversation to summarize:\n${conversationText}`;

	return generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);
}

export async function evaluateConversationChunk(
	recentMessages: string,
	existingFactSummary?: string,
): Promise<PromotionResult> {
	let contextSection = "";
	if (existingFactSummary) {
		contextSection = `
FACTS ALREADY SAVED (do NOT duplicate):
${existingFactSummary}

IMPORTANT: Only add NEW information not already covered above.

`;
	}

	const systemPrompt =
		"You are an assistant that extracts important information from conversations. Respond ONLY with valid JSON, no additional text.";

	const userMessage = `Analyze this conversation and extract:

1. **Episode summary**: A brief sentence describing what the conversation was about.
2. **Importance**: 1-5 (5 = very important).
3. **Facts about the PEOPLE**: Extract ONLY data about the people who participate in the conversation. Do NOT save general knowledge, encyclopedic data, or information about topics that were discussed (e.g., if they talk about South Korea, do NOT save facts about Korea; if they talk about a movie, do NOT save the plot).
   What TO save:
   - Personal data: name, age, job, profession, location, family
   - Personal likes, preferences, opinions, and stances
   - Personal plans, goals, future events
   - Relationships between the people in the chat
   - Habits, routines, personal experiences they share
   - Interests or topics they're passionate about (e.g., "Juan is interested in demographics", NOT "Korea's population will drop")
   What NOT to save:
   - World data, news, statistics, encyclopedic information
   - Content of videos, articles, or shared links
   - General information you can look up online
   Categories:
   - category "person": fact about a specific person (include "subject" with the FULL NAME as it appears in the messages, e.g., "Juan Pérez", NOT just "Juan")
   - category "group": group dynamic or rule of interaction between participants
   - category "rule": rule or boundary established in the relationship
   - category "event": future PERSONAL event or plan of a participant (NOT world events)
4. **Permanence**: If a fact is a FUNDAMENTAL and IMMUTABLE biographical datum about a person, mark it as "permanent": true.
   Examples of permanent facts:
   - Place of birth ("Born in Neyba")
   - Family members and their names ("My daughter is Elianny", "My wife is Anny")
   - Marriage date, birth of children ("I got married in 2006")
   - Country of origin, nationality
   - Real full name
   Examples of facts that are NOT permanent:
   - Current job (can change)
   - Likes and preferences (can change)
   - Future plans
   - Mood, opinions
   Be VERY selective: only data that will NEVER change in the person's life.
5. **Personality signals**: Does the conversation reveal something about how the bot is evolving emotionally? Only if the signals are clear.
You can ONLY use these EXACT trait names (do not invent others):
${getTraitDefinitionsForPrompt()}

If the conversation shows no clear signals, leave traitChanges empty.
Each delta must be between -0.15 and +0.15.
${contextSection}
Respond ONLY with JSON:
{"summary": "brief summary", "importance": 1-5, "facts": [{"content": "fact about the PERSON", "category": "person|group|rule|event", "subject": "name (only if person)", "context": "why it matters", "importance": 1-5, "permanent": false}], "personalitySignals": {"traitChanges": [{"trait": "warmth", "delta": 0.1, "reason": "reason for the change"}]}}

If there's nothing personally relevant: {"summary": "casual conversation", "importance": 1, "facts": [], "personalitySignals": {"traitChanges": []}}

Conversation:
${recentMessages}`;

	const text = await generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);

	try {
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch)
			return { summary: "casual conversation", importance: 1, facts: [] };
		const parsed = JSON.parse(jsonMatch[0]) as PromotionResult;
		return validatePromotionResult(parsed);
	} catch {
		return { summary: "casual conversation", importance: 1, facts: [] };
	}
}

// --- Follow-up extraction ---

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

interface ExtractedFollowUp {
	event: string;
	when: string; // ISO timestamp
	followUpDelayHours: number;
	question: string;
}

export async function extractFollowUps(
	recentMessages: string,
	currentDateDR: string,
	latestMessage: string,
): Promise<ExtractedFollowUp[]> {
	// Pre-filter: only check the latest message for follow-up intent
	if (!hasFollowUpIntent(latestMessage)) return [];

	const systemPrompt =
		"You are an assistant that detects future plans or events in conversations. Respond ONLY with valid JSON, no additional text.";

	const userMessage = `Analyze these messages and extract future plans or events mentioned by the user.

Current date and time in the Dominican Republic: ${currentDateDR}

For each plan detected, extract:
- "event": short description of the event (e.g., "go to the movies", "doctor's appointment")
- "when": estimated date and time of the event in ISO 8601 format (use the current date to resolve relative times like "tonight", "tomorrow")
- "followUpDelayHours": hours after the event to follow up (typically 1-3 hours after)
- "question": casual, natural follow-up question in the user's language (the way a friend would ask, e.g., "you never told me how the movie was!")

Respond ONLY with JSON:
{"followUps": [{"event": "...", "when": "...", "followUpDelayHours": 2, "question": "..."}]}

If there are no future plans: {"followUps": []}

Messages:
${recentMessages}`;

	try {
		const text = await generateResponse(systemPrompt, [
			{ role: "user", content: userMessage },
		]);

		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return [];

		const parsed = JSON.parse(jsonMatch[0]) as {
			followUps: ExtractedFollowUp[];
		};
		if (!Array.isArray(parsed.followUps)) return [];

		// Validate each follow-up
		return parsed.followUps.filter(
			(fu) =>
				fu.event &&
				typeof fu.event === "string" &&
				fu.when &&
				typeof fu.when === "string" &&
				!Number.isNaN(Date.parse(fu.when)) &&
				typeof fu.followUpDelayHours === "number" &&
				fu.followUpDelayHours > 0 &&
				fu.question &&
				typeof fu.question === "string",
		);
	} catch (error) {
		if (isDev) console.error("[extractFollowUps] Error:", error);
		return [];
	}
}

import { TRAIT_NAMES } from "./types.ts";

const VALID_CATEGORIES = new Set(["person", "group", "rule", "event"]);
const VALID_TRAIT_NAMES = new Set<string>(TRAIT_NAMES);

function validatePromotionResult(raw: PromotionResult): PromotionResult {
	const summary =
		typeof raw.summary === "string" && raw.summary.trim()
			? raw.summary.trim()
			: "casual conversation";

	const importance =
		typeof raw.importance === "number"
			? Math.max(1, Math.min(5, Math.round(raw.importance)))
			: 1;

	const facts = (raw.facts ?? [])
		.filter((f) => {
			if (!f.content || typeof f.content !== "string" || !f.content.trim())
				return false;
			if (!VALID_CATEGORIES.has(f.category)) return false;
			if (f.category === "person" && !f.subject?.trim()) return false;
			return true;
		})
		.map((f) => ({
			...f,
			content: f.content.trim(),
			subject: f.subject?.trim(),
			context: f.context?.trim(),
			importance:
				typeof f.importance === "number"
					? Math.max(1, Math.min(5, Math.round(f.importance)))
					: importance,
			permanent: f.permanent === true,
		}));

	// Validate personality signals
	let personalitySignals = raw.personalitySignals;
	if (personalitySignals?.traitChanges) {
		const validChanges = personalitySignals.traitChanges
			.filter(
				(c) =>
					c.trait &&
					typeof c.trait === "string" &&
					VALID_TRAIT_NAMES.has(c.trait.toLowerCase().trim()) &&
					typeof c.delta === "number" &&
					Math.abs(c.delta) >= 0.01 &&
					c.reason &&
					typeof c.reason === "string",
			)
			.map((c) => ({
				trait: c.trait.toLowerCase().trim(),
				delta: Math.max(-0.15, Math.min(0.15, c.delta)),
				reason: c.reason.trim(),
			}));
		personalitySignals =
			validChanges.length > 0 ? { traitChanges: validChanges } : undefined;
	} else {
		personalitySignals = undefined;
	}

	return { summary, importance, facts, personalitySignals };
}
