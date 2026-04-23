import type { PromptContext, PromptModeFlags } from "./types.ts";

export const isSimpleAssistantMode =
	process.env.SIMPLE_ASSISTANT_MODE === "true";

const fullAccessActive = process.env.FULL_ACCESS_MODE === "true";
const tutorActive = process.env.ENABLE_TUTOR_MODE === "true";

export function isFullAccessActive(): boolean {
	return fullAccessActive;
}

export function isTutorActive(): boolean {
	return tutorActive;
}

export function resolveModeFlags(): PromptModeFlags {
	return {
		simpleAssistant: isSimpleAssistantMode,
		fullAccess: fullAccessActive,
		tutor: tutorActive,
	};
}

export function getSuppressedIds(ctx: PromptContext): Set<string> {
	const suppressed = new Set<string>();
	if (ctx.mode.fullAccess) {
		suppressed.add("image.weekly");
		suppressed.add("image.allowedPhotoRequest");
	} else {
		suppressed.add("image.fullAccess");
	}
	if (!ctx.mode.tutor) {
		suppressed.add("voice.tutor");
	}
	return suppressed;
}
