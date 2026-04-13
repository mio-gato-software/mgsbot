import { getSuppressedIds } from "./modes.ts";
import { PIPELINE } from "./pipeline.ts";
import type { PromptContext } from "./types.ts";

const SIMPLE_ASSISTANT_PROMPT = `You are a helpful assistant. Respond clearly and concisely to user questions.`;

export async function assembleSystemPrompt(
	ctx: PromptContext,
): Promise<string> {
	if (ctx.mode.simpleAssistant) return SIMPLE_ASSISTANT_PROMPT;

	const suppressed = getSuppressedIds(ctx);
	const parts: string[] = [];
	for (const section of PIPELINE) {
		if (suppressed.has(section.id)) continue;
		const out = await section.render(ctx);
		if (out) parts.push(out);
	}
	return parts.join("\n\n");
}
