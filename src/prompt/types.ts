import type { BotRules } from "../bot-rules.ts";
import type { MentionType } from "../handlers.ts";
import type {
	Episode,
	MemoryChapter,
	RelationshipMemory,
	SemanticFact,
} from "../types.ts";

export interface PromptModeFlags {
	simpleAssistant: boolean;
	fullAccess: boolean;
	tutor: boolean;
}

export interface PromptContext {
	relevantEpisodes: Episode[];
	relevantFacts: SemanticFact[];
	permanentFacts?: SemanticFact[];
	relationshipMemory?: RelationshipMemory | null;
	recentChapters?: MemoryChapter[];
	botRules?: BotRules;
	activeNames?: string[];
	mentionedNames?: string[];
	mentionType?: MentionType;
	groupAutoReply: boolean;
	groupContinuation: boolean;
	isVoiceMessage: boolean;
	userAttachedImage: boolean;
	shouldGenerateImage: boolean;
	allowPhotoRequest: boolean;
	ttsAvailable: boolean;
	mode: PromptModeFlags;
}

export interface PromptSection {
	id: string;
	render(ctx: PromptContext): Promise<string | null> | string | null;
}
