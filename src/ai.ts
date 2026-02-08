import * as fs from "node:fs";
import {
	createPartFromUri,
	createUserContent,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import { type ChatMessage, createChatProvider } from "./providers/index.ts";
import type { MemberFact, MemoryEvaluation } from "./types.ts";

const hasGoogleApiKey = !!process.env.GOOGLE_API_KEY;
const ai = new GoogleGenAI({});
const MODEL = "gemini-3-flash-preview";

const isDev = process.env.NODE_ENV === "development";

function logTokenUsage(label: string, response: GenerateContentResponse): void {
	const usage = response.usageMetadata;
	if (!usage) return;
	console.log(
		`[tokens:${label}] in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`,
	);
}

export async function transcribeAudio(
	filePath: string,
	mimeType: string,
): Promise<string> {
	try {
		const uploaded = await ai.files.upload({
			file: filePath,
			config: { mimeType },
		});

		if (isDev) {
			console.log("[transcribeAudio] Upload result:", {
				name: uploaded.name,
				uri: uploaded.uri,
				state: uploaded.state,
				mimeType: uploaded.mimeType,
			});
		}

		// Poll until the file is ACTIVE (processing can take a few seconds)
		const MAX_POLL_ATTEMPTS = 20;
		const POLL_INTERVAL_MS = 1000;
		let fileState = uploaded.state;

		for (let i = 0; i < MAX_POLL_ATTEMPTS && fileState === "PROCESSING"; i++) {
			if (isDev)
				console.log(
					`[transcribeAudio] Polling file state (${i + 1}/${MAX_POLL_ATTEMPTS})...`,
				);
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			const fileInfo = await ai.files.get({ name: uploaded.name ?? "" });
			fileState = fileInfo.state;
		}

		if (fileState !== "ACTIVE") {
			console.error(
				`[transcribeAudio] File never became ACTIVE (state: ${fileState})`,
			);
			return "[transcription failed]";
		}

		if (isDev)
			console.log(
				"[transcribeAudio] File is ACTIVE, generating transcription...",
			);

		const response = await ai.models.generateContent({
			model: MODEL,
			contents: createUserContent([
				createPartFromUri(uploaded.uri ?? "", uploaded.mimeType ?? ""),
				"Transcribe this audio exactly as spoken, in the original language. Return ONLY the transcription, nothing else.",
			]),
		});

		logTokenUsage("transcribeAudio", response);
		const text = response.text ?? "[transcription failed]";
		if (isDev) console.log("[transcribeAudio] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		console.error("[transcribeAudio] Error:", error);
		return "[transcription failed]";
	}
}

export async function describeImage(
	filePath: string,
	mimeType: string,
	caption?: string,
): Promise<string> {
	try {
		const base64Data = fs.readFileSync(filePath, { encoding: "base64" });

		const parts: Part[] = [
			{ inlineData: { mimeType, data: base64Data } },
			{
				text: caption
					? `The user sent this image with the caption: "${caption}". Describe what you see briefly in Spanish, so you can reference it in conversation.`
					: "The user sent this image. Describe what you see briefly in Spanish, so you can reference it in conversation.",
			},
		];

		if (isDev)
			console.log(
				"[describeImage] Sending image to model, mimeType:",
				mimeType,
			);

		const response = await ai.models.generateContent({
			model: MODEL,
			contents: createUserContent(parts),
		});

		logTokenUsage("describeImage", response);
		const text = response.text ?? "[image description failed]";
		if (isDev) console.log("[describeImage] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		console.error("[describeImage] Error:", error);
		return "[image description failed]";
	}
}

export async function analyzeYouTube(
	videoUrl: string,
	userQuestion?: string,
): Promise<string> {
	try {
		const prompt = userQuestion
			? `The user shared this YouTube video and said: "${userQuestion}". Watch the video and respond to what they said.`
			: "The user shared this YouTube video. Briefly describe what the video is about in Spanish so you can reference it in conversation.";

		const parts: Part[] = [
			{ fileData: { fileUri: videoUrl } },
			{ text: prompt },
		];

		if (isDev) console.log("[analyzeYouTube] URL:", videoUrl);

		const response = await ai.models.generateContent({
			model: MODEL,
			contents: createUserContent(parts),
		});

		logTokenUsage("analyzeYouTube", response);
		const text = response.text ?? "[video analysis failed]";
		if (isDev) console.log("[analyzeYouTube] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		console.error("[analyzeYouTube] Error:", error);
		return "[video analysis failed]";
	}
}

export async function generateResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	const provider = createChatProvider();
	return provider.generateResponse(systemPrompt, messages);
}

export async function textToSpeech(text: string): Promise<string> {
	if (isDev)
		console.log(
			"[textToSpeech] API key present:",
			!!process.env.LEMON_FOX_API_KEY,
		);

	const response = await fetch("https://api.lemonfox.ai/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.LEMON_FOX_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			input: text,
			voice: "heart",
			response_format: "mp3",
		}),
		signal: AbortSignal.timeout(15000),
	});

	if (isDev) console.log("[textToSpeech] Response status:", response.status);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		throw new Error(`LemonFox TTS failed: ${response.status} ${errorBody}`);
	}

	const filePath = `./audios/tts_${Date.now()}.mp3`;
	const arrayBuffer = await response.arrayBuffer();
	if (isDev)
		console.log("[textToSpeech] Received bytes:", arrayBuffer.byteLength);
	await Bun.write(filePath, new Uint8Array(arrayBuffer));
	return filePath;
}

export function isImageGenAvailable(): boolean {
	return hasGoogleApiKey;
}

export async function generateImage(
	prompt: string,
	referenceImagePath: string,
): Promise<Buffer> {
	if (!hasGoogleApiKey) {
		throw new Error(
			"GOOGLE_API_KEY is required for image generation (Gemini-only feature)",
		);
	}
	if (isDev) console.log("[generateImage] Prompt:", prompt.slice(0, 200));

	const ext = referenceImagePath.split(".").pop() ?? "jpg";
	const mimeType = ext === "png" ? "image/png" : "image/jpeg";
	const base64Data = fs.readFileSync(referenceImagePath, {
		encoding: "base64",
	});

	const response = await ai.models.generateContent({
		model: "gemini-3-pro-image-preview",
		contents: createUserContent([
			{ inlineData: { mimeType, data: base64Data } },
			{
				text: `This is a reference image of a character in cartoon illustration style. Generate a new image of this same character (same face, body features) in the SAME cartoon/illustrated art style (flat colors, clean linework, digital illustration) but with a completely different outfit, pose, and setting. The scene: ${prompt}. The setting and atmosphere should feel natural for the described scene (e.g. indoor scenes like a bedroom, living room, restaurant, bar, mall, gym, or coffee shop should have appropriate indoor lighting; outdoor scenes like a beach, park, city street, rooftop, garden, or poolside should have appropriate natural lighting). IMPORTANT: Maintain the cartoon illustration style throughout. Do NOT render any text, clocks, timestamps, or time indicators in the image. Only the character's identity should match the reference — everything else should be new and fit the scene.`,
			},
		]),
		config: {
			responseModalities: ["IMAGE", "TEXT"],
		},
	});

	const parts = response.candidates?.[0]?.content?.parts ?? [];
	for (const part of parts) {
		if (part.inlineData?.data) {
			if (isDev) console.log("[generateImage] Image generated successfully");
			return Buffer.from(part.inlineData.data, "base64");
		}
	}

	throw new Error("No image data in response");
}

interface ExistingMemoryContext {
	memories: Array<{ content: string; importance: number }>;
	memberFacts: Record<string, string[]>; // member -> list of keys
}

export async function summarizeConversation(
	conversationText: string,
	existingSummary?: string,
): Promise<string> {
	const context = existingSummary
		? `Previous context: ${existingSummary}\n\n`
		: "";

	const systemPrompt =
		"You are a summarizer. Create a concise summary of the conversation, preserving key facts, decisions, and context. Keep it under 150 words.";
	const userMessage = `${context}Conversation to summarize:\n${conversationText}`;

	return generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);
}

export async function evaluateMemory(
	recentMessages: string,
	existingContext?: ExistingMemoryContext,
): Promise<MemoryEvaluation> {
	// Build context section if we have existing memories
	let contextSection = "";
	if (existingContext) {
		const memSummary = existingContext.memories
			.slice(0, 7)
			.map((m) => `- ${m.content} (imp: ${m.importance})`)
			.join("\n");

		const factsSummary = Object.entries(existingContext.memberFacts)
			.map(([member, keys]) => `- ${member}: ${keys.join(", ")}`)
			.join("\n");

		if (memSummary || factsSummary) {
			contextSection = `
MEMORIAS YA GUARDADAS (NO duplicar):
${memSummary || "(ninguna)"}

KEYS YA USADAS POR MIEMBRO:
${factsSummary || "(ninguno)"}

IMPORTANTE: Solo agrega información NUEVA que no esté ya cubierta arriba. Si la información ya existe (aunque con diferentes palabras), NO la incluyas.

`;
		}
	}

	const systemPrompt =
		"Eres un asistente que extrae información importante de conversaciones. Responde SOLO con JSON válido, sin texto adicional.";

	const userMessage = `Extrae de esta conversación:
1. **Memorias**: SOLO información general que NO sea sobre un miembro específico. Ejemplos: eventos grupales, reglas de interacción, dinámicas de la relación, fechas importantes compartidas. NUNCA incluyas aquí datos personales de alguien (trabajo, familia, horario, ubicación, preferencias individuales) — esos van SOLO en memberFacts.
2. **Hechos por miembro**: datos personales de miembros específicos (trabajo, hobby, relación, familia, horario, ubicación, preferencias). Key corto en español (ej: "empleo", "hobby", "mascota"). Mismo key para actualizar info previa.
${contextSection}
Responde SOLO JSON:
{"save": boolean, "memories": [{"content": "qué", "context": "por qué", "importance": 1-5}], "memberFacts": [{"member": "Nombre", "key": "tema", "content": "hecho"}]}
Si no hay nada: {"save": false, "memories": [], "memberFacts": []}

Conversación:
${recentMessages}`;

	const text = await generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);

	try {
		// Extract JSON from possible markdown code block
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return { save: false, memories: [], memberFacts: [] };
		const parsed = JSON.parse(jsonMatch[0]) as MemoryEvaluation;
		parsed.memberFacts = parsed.memberFacts ?? [];
		return parsed;
	} catch {
		return { save: false, memories: [], memberFacts: [] };
	}
}

export async function consolidateMemberFacts(
	memberName: string,
	facts: MemberFact[],
	maxFacts: number,
): Promise<MemberFact[]> {
	const factsText = facts.map((f) => `- ${f.key}: ${f.content}`).join("\n");

	const systemPrompt = `Eres un asistente que consolida datos sobre personas. Responde SOLO con un JSON array, sin texto adicional.`;

	const userMessage = `Consolida estos datos sobre "${memberName}" en máximo ${maxFacts} hechos. Combina información relacionada en un solo hecho más completo (ej: gustos de comida en uno, datos laborales en uno). Mantén lo más importante y reciente. Usa keys cortos en español.

Datos actuales:
${factsText}

Responde SOLO JSON array:
[{"key": "tema-corto", "content": "hecho consolidado"}]`;

	const text = await generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);

	try {
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return fallbackPrune(facts, maxFacts);
		const parsed = JSON.parse(jsonMatch[0]) as Array<{
			key: string;
			content: string;
		}>;
		if (!Array.isArray(parsed) || parsed.length === 0)
			return fallbackPrune(facts, maxFacts);
		const now = Date.now();
		return parsed.map((f) => ({
			key: f.key,
			content: f.content,
			updatedAt: now,
		}));
	} catch {
		return fallbackPrune(facts, maxFacts);
	}
}

function fallbackPrune(facts: MemberFact[], maxFacts: number): MemberFact[] {
	return [...facts]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, maxFacts);
}

export async function consolidateLongTermMemories(
	entries: Array<{ content: string; context: string; importance: number }>,
	targetCount: number,
	memberFacts?: Record<string, string[]>,
): Promise<Array<{ content: string; context: string; importance: number }>> {
	const entriesText = entries
		.map((e) => `- [imp:${e.importance}] ${e.content} (${e.context})`)
		.join("\n");

	let memberFactsSection = "";
	if (memberFacts && Object.keys(memberFacts).length > 0) {
		const factsText = Object.entries(memberFacts)
			.map(([member, facts]) => `- ${member}: ${facts.join(", ")}`)
			.join("\n");
		memberFactsSection = `\nDATOS YA GUARDADOS POR MIEMBRO (ELIMINAR de memorias si aparecen aquí):
${factsText}\n`;
	}

	const systemPrompt =
		"Eres un asistente que consolida memorias. Responde SOLO con un JSON array, sin texto adicional.";

	const userMessage = `Consolida estas ${entries.length} memorias en máximo ${targetCount}. Reglas:
- Combina duplicados y paráfrasis en una sola entrada más completa
- Elimina trivialidades (clima pasado, actividades momentáneas, saludos)
- Preserva: eventos con fecha, reglas de interacción, dinámicas grupales, decisiones importantes
- ELIMINA cualquier memoria que sea un dato personal de un miembro (trabajo, familia, horario, ubicación, preferencias individuales) — esos ya están en member facts
- Mantén la importancia más alta cuando combines entradas
${memberFactsSection}
Memorias actuales:
${entriesText}

Responde SOLO JSON array:
[{"content": "qué", "context": "por qué", "importance": 1-5}]`;

	const text = await generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);

	try {
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return entries.slice(0, targetCount);
		const parsed = JSON.parse(jsonMatch[0]) as Array<{
			content: string;
			context: string;
			importance: number;
		}>;
		if (!Array.isArray(parsed) || parsed.length === 0)
			return entries.slice(0, targetCount);
		return parsed;
	} catch {
		return entries.slice(0, targetCount);
	}
}
