// Barrel export: src/ai.ts re-exports from specialized modules
// This maintains backward compatibility during migration

// Classification and intent detection
export { classifyEditIntent, hasFollowUpIntent } from "./ai/classifiers.ts";
// Core AI functionality
export { generateResponse } from "./ai/core.ts";
// Conversation evaluation and follow-up extraction
export {
	evaluateConversationChunk,
	extractFollowUps,
	summarizeConversation,
} from "./ai/evaluation.ts";
// Vision and media analysis
export { analyzeYouTube, describeImage } from "./ai/vision.ts";

// Re-export STT functionality from its own module
export { transcribeAudio } from "./stt/index.ts";
