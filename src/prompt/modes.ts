import { isFullAccessActive } from "../full-access.ts";
import { isTutorActive } from "../tutor.ts";
import type { PromptContext, PromptModeFlags } from "./types.ts";

export const isSimpleAssistantMode =
	process.env.SIMPLE_ASSISTANT_MODE === "true";

export function resolveModeFlags(): PromptModeFlags {
	return {
		simpleAssistant: isSimpleAssistantMode,
		fullAccess: isFullAccessActive(),
		tutor: isTutorActive(),
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
