export interface ConversationMessage {
	role: "user" | "model";
	name?: string;
	content: string;
	timestamp: number;
}

export interface ShortTermMemory {
	chatId: number;
	messages: ConversationMessage[];
	previousSummary: string;
	lastActivity: number;
	messageCountSinceEval: number;
}

export interface LongTermMemoryEntry {
	id: string;
	content: string;
	context: string;
	createdAt: number;
	lastAccessed: number;
	importance: number;
}

export interface MemoryEvaluation {
	save: boolean;
	memories: Array<{
		content: string;
		context: string;
		importance: number;
	}>;
}
