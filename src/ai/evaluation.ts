import { getTraitDefinitionsForPrompt } from "../personality.ts";
import type { PromotionResult } from "../types.ts";
import { TRAIT_NAMES } from "../types.ts";
import { hasFollowUpIntent } from "./classifiers.ts";
import { generateResponse } from "./core.ts";

const isDev = process.env.NODE_ENV === "development";

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
