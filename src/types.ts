/**
 * Type of mention detected in a group message.
 * - "none": Bot not mentioned at all
 * - "reply": User replied to bot's message (always respond)
 * - "tag": User @mentioned the bot (always respond)
 * - "name": User mentioned bot's name (AI decides if addressed or just mentioned)
 */
export type MentionType = "none" | "reply" | "tag" | "name";

export interface ConversationMessage {
	id?: string; // stable identity across durable promotion retries
	role: "user" | "model";
	name?: string;
	userId?: number;
	content: string;
	timestamp: number;
}

// --- New Memory Architecture ---

export interface SensoryBuffer {
	schemaVersion?: number; // absent in legacy files; stamped on save
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
	embeddingModel?: string;
	embeddingDim?: number;
}

export interface WorkingMemory {
	schemaVersion?: number; // absent in legacy files; stamped on save
	chatId: number;
	episodes: Episode[]; // max 20
}

export interface RelationshipMemory {
	appliedEpisodeIds?: string[];
	schemaVersion?: number; // absent in legacy files; stamped on save
	chatId: number;
	summary: string; // 80-140 words about the relationship dynamic
	tone: string; // e.g. "warm, playful, direct"
	notableDynamics: string[]; // max 5
	openThreads: string[]; // max 5, relational topics that still feel alive
	updatedAt: number;
	interactionCount: number;
}

export interface MemoryChapter {
	id: string; // "chapter_<chatId>_<YYYY-MM>"
	chatId: number;
	month: string; // YYYY-MM in bot timezone
	title: string;
	summary: string; // compact narrative of the month
	participants: string[];
	importance: number; // 1-5
	episodeIds: string[];
	updatedAt: number;
}

export interface SemanticFact {
	appliedFactIds?: string[]; // idempotency receipts for merged extracted facts
	id: string;
	content: string; // atomic fact
	category: "person" | "group" | "rule" | "event";
	subject?: string; // person name (if category="person")
	context?: string; // why it matters
	embedding: number[]; // 768-dim vector
	embeddingModel?: string;
	embeddingDim?: number;
	importance: number; // 1-5
	confidence: number; // 0-1, decays if not reconfirmed
	createdAt: number;
	lastConfirmed: number; // genuine reconfirmation (extraction), NOT retrieval
	lastRecalledAt?: number; // last time retrieval injected it into a prompt
	lastDecayedAt?: number;
	scope?: "global" | "chat" | "person";
	sourceChatId?: number;
	validUntil?: number;
	supersedes?: string[];
	supersededBy?: string;
	permanent?: boolean; // never decays, always included in prompt
}

export interface FollowUp {
	id: string; // "fu_<timestamp>_<random>"
	chatId: number;
	event: string; // "ir al cine a las 8pm"
	followUpQuestion: string; // Pre-generated fallback question
	detectedAt: number;
	scheduledFor: number; // When to ask
	sentAt?: number; // Actual send moment (absent on legacy entries)
	status: "pending" | "sent" | "cancelled" | "expired";
	attempts: number;
}

// --- Evolving Personality ---

export const TRAIT_NAMES = [
	"warmth",
	"humor",
	"patience",
	"curiosity",
	"assertiveness",
	"energy",
	"vulnerability",
	"playfulness",
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
	appliedPromotionIds?: string[];
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
	recentMessages?: Array<{ text: string; sentAt: number }>; // Last 5 proactive messages sent (topic anti-repetition)
	unansweredStreak?: number; // Consecutive proactive sends without a user reply (as of the last send)
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
		supersedes?: string[];
	}>;
	personalitySignals?: PersonalitySignals;
	/** Extraction telemetry — how the background model behaved on this chunk. */
	extraction?: {
		model: string;
		/** Facts the validator rejected (bad category, missing subject, ...). */
		droppedFacts: number;
	};
}
