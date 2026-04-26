import type { MentionType } from "../handlers.ts";
import type {
	Episode,
	MemoryChapter,
	RelationshipMemory,
	SemanticFact,
} from "../types.ts";
import { resolveModeFlags } from "./modes.ts";
import type { PromptContext } from "./types.ts";

export interface PromptContextInput {
	relevantEpisodes: Episode[];
	relevantFacts: SemanticFact[];
	permanentFacts?: SemanticFact[];
	relationshipMemory?: RelationshipMemory | null;
	recentChapters?: MemoryChapter[];
	activeNames?: string[];
	mentionedNames?: string[];
	mentionType?: MentionType;
	isVoiceMessage?: boolean;
	userAttachedImage?: boolean;
	shouldGenerateImage?: boolean;
	allowPhotoRequest?: boolean;
	ttsAvailable?: boolean;
}

export function buildPromptContext(input: PromptContextInput): PromptContext {
	return {
		relevantEpisodes: input.relevantEpisodes,
		relevantFacts: input.relevantFacts,
		permanentFacts: input.permanentFacts,
		relationshipMemory: input.relationshipMemory,
		recentChapters: input.recentChapters,
		activeNames: input.activeNames,
		mentionedNames: input.mentionedNames,
		mentionType: input.mentionType,
		isVoiceMessage: input.isVoiceMessage === true,
		userAttachedImage: input.userAttachedImage === true,
		shouldGenerateImage: input.shouldGenerateImage === true,
		allowPhotoRequest: input.allowPhotoRequest === true,
		ttsAvailable: input.ttsAvailable === true,
		mode: resolveModeFlags(),
	};
}
