import * as fs from "node:fs";
import {
	createPartFromUri,
	createUserContent,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import { type ChatMessage, createChatProvider } from "./providers/index.ts";
import type { PromotionResult } from "./types.ts";

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

export async function summarizeConversation(
	conversationText: string,
	existingEpisodes?: string[],
): Promise<string> {
	const context = existingEpisodes?.length
		? `Previous episode summaries:\n${existingEpisodes.map((e) => `- ${e}`).join("\n")}\n\n`
		: "";

	const systemPrompt =
		"You are a summarizer. Create a concise summary of the conversation, preserving key facts, decisions, and context. Keep it under 150 words.";
	const userMessage = `${context}Conversation to summarize:\n${conversationText}`;

	return generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);
}

export async function evaluateConversationChunk(
	recentMessages: string,
	existingFactSummary?: string,
): Promise<PromotionResult> {
	let contextSection = "";
	if (existingFactSummary) {
		contextSection = `
HECHOS YA GUARDADOS (NO duplicar):
${existingFactSummary}

IMPORTANTE: Solo agrega información NUEVA que no esté ya cubierta arriba.

`;
	}

	const systemPrompt =
		"Eres un asistente que extrae información importante de conversaciones. Responde SOLO con JSON válido, sin texto adicional.";

	const userMessage = `Analiza esta conversación y extrae:

1. **Resumen del episodio**: Una oración breve describiendo de qué se trató la conversación.
2. **Importancia**: 1-5 (5 = muy importante).
3. **Hechos atómicos**: Datos específicos extraídos. Cada hecho debe ser una oración independiente.
   - category "person": dato sobre una persona específica (incluye "subject" con el nombre)
   - category "group": dinámica grupal o regla de interacción
   - category "rule": regla o límite establecido en la relación
   - category "event": evento, fecha o plan
${contextSection}
Responde SOLO JSON:
{"summary": "resumen breve", "importance": 1-5, "facts": [{"content": "hecho", "category": "person|group|rule|event", "subject": "nombre (solo si person)", "context": "por qué importa", "importance": 1-5}]}

Si no hay nada relevante: {"summary": "conversación casual", "importance": 1, "facts": []}

Conversación:
${recentMessages}`;

	const text = await generateResponse(systemPrompt, [
		{ role: "user", content: userMessage },
	]);

	try {
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch)
			return { summary: "conversación casual", importance: 1, facts: [] };
		const parsed = JSON.parse(jsonMatch[0]) as PromotionResult;
		parsed.facts = parsed.facts ?? [];
		return parsed;
	} catch {
		return { summary: "conversación casual", importance: 1, facts: [] };
	}
}
