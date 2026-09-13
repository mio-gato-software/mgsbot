import { recordMemoryUsage } from "../memory/usage-metrics.ts";
import { getSuppressedIds } from "./modes.ts";
import { PIPELINE } from "./pipeline.ts";
import type { PromptContext } from "./types.ts";

// Character ceilings are deterministic across chat providers; actual model tokens
// are reported separately. Include separators in the total memory allowance.
export const MEMORY_PROMPT_MAX_CHARS = 12_000;
const MEMORY_SECTION_LIMITS: Record<string, number> = {
	"memory.relationship": 1800,
	"memory.chapters": 2600,
	"memory.episodes": 1200,
	"memory.permanentFacts.persons": 3000,
	"memory.permanentFacts.other": 1000,
	"memory.persons": 1800,
	"memory.generalFacts": 600,
};
export function fitMemorySection(text: string, limit: number): string {
	const lines: string[] = [];
	let length = 0;
	for (const line of text.split("\n")) {
		if (length + line.length + 1 > limit) break;
		lines.push(line);
		length += line.length + 1;
	}
	return lines.join("\n");
}

const SIMPLE_ASSISTANT_PROMPT = `You are a helpful assistant. Respond clearly and concisely to user questions.`;

export async function assembleSystemPrompt(
	ctx: PromptContext,
): Promise<string> {
	if (ctx.mode.simpleAssistant) return SIMPLE_ASSISTANT_PROMPT;

	const suppressed = getSuppressedIds(ctx);
	const parts: string[] = [];
	let memoryChars = 0;
	for (const section of PIPELINE) {
		if (suppressed.has(section.id)) continue;
		let out = await section.render(ctx);
		if (out && section.id.startsWith("memory.")) {
			out = fitMemorySection(
				out,
				Math.max(
					0,
					Math.min(
						MEMORY_SECTION_LIMITS[section.id] ?? 1000,
						MEMORY_PROMPT_MAX_CHARS - memoryChars - 2,
					),
				),
			);
			if (out) memoryChars += out.length + 2;
		}
		if (out) parts.push(out);
	}
	await recordMemoryUsage({ operation: "prompt", status: "ok", memoryChars });
	return parts.join("\n\n");
}
