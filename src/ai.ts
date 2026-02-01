import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
  type Content,
} from "@google/genai";
import type { MemoryEvaluation } from "./types.ts";

const ai = new GoogleGenAI({});
const MODEL = "gemini-3-flash-preview";

export async function transcribeAudio(
  filePath: string,
  mimeType: string,
): Promise<string> {
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType },
  });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: createUserContent([
      createPartFromUri(uploaded.uri!, uploaded.mimeType!),
      "Transcribe this audio exactly as spoken, in the original language. Return ONLY the transcription, nothing else.",
    ]),
  });
  return response.text!;
}

export async function generateResponse(
  systemPrompt: string,
  contents: Content[],
): Promise<string> {
  const response = await ai.models.generateContent({
    model: MODEL,
    config: {
      systemInstruction: systemPrompt,
    },
    contents,
  });
  return response.text ?? "";
}

export async function evaluateMemory(
  recentMessages: string,
): Promise<MemoryEvaluation> {
  const prompt = `Analyze the following conversation excerpt. Determine if there is any information worth remembering long-term (facts about users, preferences, important events, decisions made, etc.).

Respond ONLY with valid JSON in this exact format:
{"save": boolean, "memories": [{"content": "what to remember", "context": "why it matters", "importance": N}]}

Where importance is 1-5 (1=trivial, 5=critical).
If nothing is worth remembering, respond with: {"save": false, "memories": []}

Conversation:
${recentMessages}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: createUserContent([prompt]),
  });

  const text = response.text ?? '{"save": false, "memories": []}';
  try {
    // Extract JSON from possible markdown code block
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { save: false, memories: [] };
    return JSON.parse(jsonMatch[0]) as MemoryEvaluation;
  } catch {
    return { save: false, memories: [] };
  }
}
