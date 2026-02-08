export interface ConversationMessage {
	role: "user" | "model";
	name?: string;
	content: string;
	timestamp: number;
}

// --- New Memory Architecture ---

export interface SensoryBuffer {
	chatId: number;
	messages: ConversationMessage[]; // max 10, FIFO
	lastActivity: number;
	messageCountSincePromotion: number;
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
	}>;
}
