import type { Content } from "@google/genai";
import type { ShortTermMemory, LongTermMemoryEntry } from "./types.ts";
import { loadPermanent } from "./memory.ts";

export async function buildSystemPrompt(
  relevantMemories: LongTermMemoryEntry[],
  previousSummary: string,
): Promise<string> {
  const permanent = await loadPermanent();

  let systemPrompt = permanent;

  if (relevantMemories.length > 0) {
    const memoriesText = relevantMemories
      .map((m) => `- ${m.content} (context: ${m.context})`)
      .join("\n");
    systemPrompt += `\n\n## Long-term memories\nThings you remember from past interactions:\n${memoriesText}`;
  }

  if (previousSummary) {
    systemPrompt += `\n\n## Previous conversation context\n${previousSummary}`;
  }

  return systemPrompt;
}

export function buildContents(memory: ShortTermMemory): Content[] {
  const contents: Content[] = [];

  for (const msg of memory.messages) {
    const role = msg.role === "user" ? "user" : "model";
    const text =
      msg.role === "user" && msg.name
        ? `[${msg.name}]: ${msg.content}`
        : msg.content;

    contents.push({
      role,
      parts: [{ text }],
    });
  }

  return contents;
}
