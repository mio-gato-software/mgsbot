/**
 * Type of mention detected in a group message.
 * - "none": Bot not mentioned at all
 * - "reply": User replied to bot's message (always respond)
 * - "tag": User @mentioned the bot (always respond)
 * - "name": User mentioned bot's name (AI decides if addressed or just mentioned)
 */
export type MentionType = "none" | "reply" | "tag" | "name";

export interface ConversationMessage {
	role: "user" | "model";
	name?: string;
	userId?: number;
	content: string;
	timestamp: number;
}

// --- New Memory Architecture ---

export interface SensoryBuffer {
	chatId: number;
	messages: ConversationMessage[]; // max 10, FIFO
	lastActivity: number;
	messageCountSincePromotion: number;
	allowPhotoRequest?: boolean;
	// Image scheduling (migrated from old ShortTermMemory)
	lastImageDate?: string;
	imageTargetTime?: string;
	imageTargetDate?: string;
}

export interface Episode {
	id: string;
	summary: string; // 1-2 sentences
	participants: string[];
	timestamp: number;
	importance: number; // 1-5
	embedding: number[]; // 768-dim vector
}

export interface WorkingMemory {
	chatId: number;
	episodes: Episode[]; // max 20
}

export interface SemanticFact {
	id: string;
	content: string; // atomic fact
	category: "person" | "group" | "rule" | "event";
	subject?: string; // person name (if category="person")
	context?: string; // why it matters
	embedding: number[]; // 768-dim vector
	importance: number; // 1-5
	confidence: number; // 0-1, decays if not reconfirmed
	createdAt: number;
	lastConfirmed: number;
	permanent?: boolean; // never decays, always included in prompt
}

export interface FollowUp {
	id: string; // "fu_<timestamp>_<random>"
	chatId: number;
	event: string; // "ir al cine a las 8pm"
	followUpQuestion: string; // Pre-generated fallback question
	detectedAt: number;
	scheduledFor: number; // When to ask
	status: "pending" | "sent" | "cancelled" | "expired";
	attempts: number;
}

// --- Evolving Personality ---

export const TRAIT_NAMES = [
	"calidez",
	"humor",
	"paciencia",
	"curiosidad",
	"asertividad",
	"energia",
	"vulnerabilidad",
	"picardia",
] as const;

export type TraitName = (typeof TRAIT_NAMES)[number];

export interface PersonalityTrait {
	value: number; // 0.0–1.0 (0.5 = neutral)
	momentum: number; // -1.0–1.0 (direction of recent change)
	lastReinforced: number; // timestamp
}

export interface PersonalityGrowthEvent {
	change: string; // description of the change (Spanish)
	trigger: string; // what caused it (conversation excerpt)
	timestamp: number;
	traitsAffected: string[];
}

export interface PersonalityState {
	version?: number;
	traits: Record<string, PersonalityTrait>;
	recentGrowth: PersonalityGrowthEvent[]; // max 10
}

// --- Proactive Check-Ins ---

export interface CheckInSlot {
	scheduledFor: number; // Unix timestamp
	status: "pending" | "sent" | "skipped";
}

export interface CheckInState {
	chatId: number;
	weekStart: string; // "2026-03-09" (ISO date of Monday)
	slots: CheckInSlot[]; // N slots per week
	lastSentTimestamp: number; // When the last check-in was sent
	recentStrategies: string[]; // Last 5 strategies used (anti-repetition)
}

export interface PersonalitySignals {
	traitChanges: Array<{
		trait: string; // must be one of TRAIT_NAMES
		delta: number; // -0.15 to +0.15
		reason: string; // why it changed
	}>;
}

export interface PromotionResult {
	summary: string; // episode summary
	importance: number; // 1-5
	facts: Array<{
		content: string;
		category: "person" | "group" | "rule" | "event";
		subject?: string;
		context?: string;
		importance: number;
		permanent?: boolean;
	}>;
	personalitySignals?: PersonalitySignals;
}
