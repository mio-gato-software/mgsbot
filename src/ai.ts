import * as fs from "node:fs";
import {
	createPartFromUri,
	createUserContent,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import { getTraitDefinitionsForPrompt } from "./personality.ts";
import { type ChatMessage, createChatProvider } from "./providers/index.ts";
import { supportsVision } from "./providers/types.ts";
import type { PromotionResult } from "./types.ts";

const hasGoogleApiKey = !!process.env.GOOGLE_API_KEY;
let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}
const MODEL = "gemini-3-flash-preview";

const isDev = process.env.NODE_ENV === "development";

function logTokenUsage(label: string, response: GenerateContentResponse): void {
	const usage = response.usageMetadata;
	if (!usage) return;
	console.log(
		`[tokens:${label}] in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`,
	);
}

const useLemonFoxSTT =
	!!process.env.LEMON_FOX_API_KEY &&
	process.env.STT_PROVIDER?.toLowerCase() !== "gemini";

async function transcribeWithLemonFox(filePath: string): Promise<string> {
	if (isDev) console.log("[transcribeAudio] Using LemonFox STT");

	const fileBuffer = await Bun.file(filePath).arrayBuffer();
	const fileName = filePath.split("/").pop() ?? "audio.ogg";

	const body = new FormData();
	body.append("file", new Blob([fileBuffer]), fileName);
	body.append("response_format", "json");

	const response = await fetch(
		"https://api.lemonfox.ai/v1/audio/transcriptions",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.LEMON_FOX_API_KEY}`,
			},
			body,
			signal: AbortSignal.timeout(30_000),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		throw new Error(`LemonFox STT failed: ${response.status} ${errorBody}`);
	}

	const data = (await response.json()) as { text?: string };
	const text = data.text?.trim();
	if (!text) throw new Error("LemonFox STT returned empty text");
	if (isDev) console.log("[transcribeAudio] Result:", text.slice(0, 200));
	return text;
}

async function transcribeWithGemini(
	filePath: string,
	mimeType: string,
): Promise<string> {
	if (isDev) console.log("[transcribeAudio] Using Gemini STT");

	const uploaded = await getAI().files.upload({
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
		const fileInfo = await getAI().files.get({ name: uploaded.name ?? "" });
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

	const response = await getAI().models.generateContent({
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
}

export async function transcribeAudio(
	filePath: string,
	mimeType: string,
): Promise<string> {
	try {
		if (useLemonFoxSTT) {
			return await transcribeWithLemonFox(filePath);
		}
		return await transcribeWithGemini(filePath, mimeType);
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

		const provider = createChatProvider();
		if (supportsVision(provider)) {
			if (isDev)
				console.log(
					`[describeImage] Using provider: ${provider.name} (${provider.model})`,
				);
			try {
				return await provider.describeImage(base64Data, mimeType, caption);
			} catch (error) {
				console.error(
					`[describeImage] Provider ${provider.name} failed, falling back to Gemini:`,
					error,
				);
			}
		}

		if (isDev) console.log("[describeImage] Using Gemini, mimeType:", mimeType);

		const parts: Part[] = [
			{ inlineData: { mimeType, data: base64Data } },
			{
				text: caption
					? `The user sent this image with the caption: "${caption}". Describe what you see briefly so you can reference it in conversation.`
					: "The user sent this image. Describe what you see briefly so you can reference it in conversation.",
			},
		];

		const response = await getAI().models.generateContent({
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

		const response = await getAI().models.generateContent({
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

	const response = await getAI().models.generateContentStream({
		model: "gemini-3-pro-image-preview",
		contents: createUserContent([
			{ inlineData: { mimeType, data: base64Data } },
			{
				text: `This is a reference image of a character in cartoon illustration style. Generate a new image of this same character (same face, body features) in the SAME cartoon/illustrated art style (flat colors, clean linework, digital illustration) but with a completely different outfit, pose, and setting. The scene: ${prompt}. The setting and atmosphere should feel natural for the described scene (e.g. indoor scenes like a bedroom, living room, restaurant, bar, mall, gym, or office should have appropriate indoor lighting; outdoor scenes like a beach, park, city street, rooftop, garden, or poolside should have appropriate natural lighting). IMPORTANT: Maintain the cartoon illustration style throughout. Do NOT render any text, clocks, timestamps, or time indicators in the image. Only the character's identity should match the reference — everything else should be new and fit the scene.`,
			},
		]),
		config: {
			imageConfig: {
				imageSize: "1K",
				personGeneration: "",
			},
			responseModalities: ["IMAGE", "TEXT"],
		},
	});

	for await (const chunk of response) {
		const parts = chunk.candidates?.[0]?.content?.parts;
		if (!parts) continue;
		for (const part of parts) {
			if (part.inlineData?.data) {
				if (isDev) console.log("[generateImage] Image generated successfully");
				return Buffer.from(part.inlineData.data, "base64");
			}
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
3. **Hechos sobre las PERSONAS**: Extrae SOLO datos sobre las personas que participan en la conversación. NO guardes conocimiento general, datos enciclopédicos, ni información sobre temas que se discutieron (ej: si hablan de Corea del Sur, NO guardes datos sobre Corea; si hablan de una película, NO guardes la trama).
   Lo que SÍ guardar:
   - Datos personales: nombre, edad, trabajo, profesión, ubicación, familia
   - Gustos, preferencias, opiniones y posturas personales
   - Planes, metas, eventos personales futuros
   - Relaciones entre las personas del chat
   - Hábitos, rutinas, experiencias personales que comparten
   - Intereses o temas que les apasionan (ej: "A Juan le interesa la demografía", NO "La población de Corea bajará")
   Lo que NO guardar:
   - Datos del mundo, noticias, estadísticas, información enciclopédica
   - Contenido de videos, artículos o enlaces compartidos
   - Información general que se puede buscar en internet
   Categorías:
   - category "person": dato sobre una persona específica (incluye "subject" con el NOMBRE COMPLETO tal como aparece en los mensajes, ej: "Juan Pérez", NO solo "Juan")
   - category "group": dinámica grupal o regla de interacción entre los participantes
   - category "rule": regla o límite establecido en la relación
   - category "event": evento PERSONAL futuro o plan de un participante (NO eventos mundiales)
4. **Permanencia**: Si un hecho es un dato biográfico FUNDAMENTAL e INMUTABLE de una persona, márcalo como "permanent": true.
   Ejemplos de hechos permanentes:
   - Lugar de nacimiento ("Nací en Neyba")
   - Miembros de familia y sus nombres ("Mi hija se llama Elianny", "Mi esposa se llama Anny")
   - Fecha de matrimonio, nacimiento de hijos ("Me casé en 2006")
   - País de origen, nacionalidad
   - Nombre completo real
   Ejemplos de hechos que NO son permanentes:
   - Trabajo actual (puede cambiar)
   - Gustos y preferencias (pueden cambiar)
   - Planes futuros
   - Estado de ánimo, opiniones
   Sé MUY selectivo: solo datos que NUNCA cambiarán en la vida de la persona.
5. **Señales de personalidad**: ¿La conversación revela algo sobre cómo el bot está evolucionando emocionalmente? Solo si hay señales claras.
Solo puedes usar estos rasgos EXACTOS (no inventes otros):
${getTraitDefinitionsForPrompt()}

Si la conversación no muestra señales claras, deja traitChanges vacío.
Cada delta debe estar entre -0.15 y +0.15.
${contextSection}
Responde SOLO JSON:
{"summary": "resumen breve", "importance": 1-5, "facts": [{"content": "hecho sobre la PERSONA", "category": "person|group|rule|event", "subject": "nombre (solo si person)", "context": "por qué importa", "importance": 1-5, "permanent": false}], "personalitySignals": {"traitChanges": [{"trait": "calidez", "delta": 0.1, "reason": "razón del cambio"}]}}

Si no hay nada personal relevante: {"summary": "conversación casual", "importance": 1, "facts": [], "personalitySignals": {"traitChanges": []}}

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
		return validatePromotionResult(parsed);
	} catch {
		return { summary: "conversación casual", importance: 1, facts: [] };
	}
}

// --- Follow-up extraction ---

const FOLLOW_UP_INTENT_PATTERNS = [
	/\b(voy a|iré a|vamos a|tengo que|me toca|tengo una?)\b/i,
	/\b(esta noche|mañana|esta tarde|hoy|el lunes|el martes|el miércoles|el jueves|el viernes|el sábado|el domingo|este fin de semana)\b/i,
	/\b(cita|reunión|entrevista|examen|viaje|cine|película|doctor|fiesta|concierto|clase|gym|gimnasio|salón|peluquería)\b/i,
	/\b(a las \d{1,2}|pm|am)\b/i,
];

export function hasFollowUpIntent(text: string): boolean {
	let matchCount = 0;
	for (const pattern of FOLLOW_UP_INTENT_PATTERNS) {
		if (pattern.test(text)) matchCount++;
	}
	// Require at least 2 pattern matches to reduce false positives
	return matchCount >= 2;
}

interface ExtractedFollowUp {
	event: string;
	when: string; // ISO timestamp
	followUpDelayHours: number;
	question: string;
}

export async function extractFollowUps(
	recentMessages: string,
	currentDateDR: string,
	latestMessage: string,
): Promise<ExtractedFollowUp[]> {
	// Pre-filter: only check the latest message for follow-up intent
	if (!hasFollowUpIntent(latestMessage)) return [];

	const systemPrompt =
		"Eres un asistente que detecta planes o eventos futuros en conversaciones. Responde SOLO con JSON válido, sin texto adicional.";

	const userMessage = `Analiza estos mensajes y extrae planes o eventos futuros mencionados por el usuario.

Fecha y hora actual en República Dominicana: ${currentDateDR}

Para cada plan detectado, extrae:
- "event": descripción corta del evento (ej: "ir al cine", "cita con el doctor")
- "when": fecha y hora estimada del evento en formato ISO 8601 (usa la fecha actual para resolver tiempos relativos como "esta noche", "mañana")
- "followUpDelayHours": horas después del evento para hacer seguimiento (normalmente 1-3 horas después)
- "question": pregunta casual y natural para hacer seguimiento (como haría una amiga, ej: "no me dijiste cómo te fue en el cine!")

Responde SOLO JSON:
{"followUps": [{"event": "...", "when": "...", "followUpDelayHours": 2, "question": "..."}]}

Si no hay planes futuros: {"followUps": []}

Mensajes:
${recentMessages}`;

	try {
		const text = await generateResponse(systemPrompt, [
			{ role: "user", content: userMessage },
		]);

		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return [];

		const parsed = JSON.parse(jsonMatch[0]) as {
			followUps: ExtractedFollowUp[];
		};
		if (!Array.isArray(parsed.followUps)) return [];

		// Validate each follow-up
		return parsed.followUps.filter(
			(fu) =>
				fu.event &&
				typeof fu.event === "string" &&
				fu.when &&
				typeof fu.when === "string" &&
				!Number.isNaN(Date.parse(fu.when)) &&
				typeof fu.followUpDelayHours === "number" &&
				fu.followUpDelayHours > 0 &&
				fu.question &&
				typeof fu.question === "string",
		);
	} catch (error) {
		if (isDev) console.error("[extractFollowUps] Error:", error);
		return [];
	}
}

import { TRAIT_NAMES } from "./types.ts";

const VALID_CATEGORIES = new Set(["person", "group", "rule", "event"]);
const VALID_TRAIT_NAMES = new Set<string>(TRAIT_NAMES);

function validatePromotionResult(raw: PromotionResult): PromotionResult {
	const summary =
		typeof raw.summary === "string" && raw.summary.trim()
			? raw.summary.trim()
			: "conversación casual";

	const importance =
		typeof raw.importance === "number"
			? Math.max(1, Math.min(5, Math.round(raw.importance)))
			: 1;

	const facts = (raw.facts ?? [])
		.filter((f) => {
			if (!f.content || typeof f.content !== "string" || !f.content.trim())
				return false;
			if (!VALID_CATEGORIES.has(f.category)) return false;
			if (f.category === "person" && (!f.subject || !f.subject.trim()))
				return false;
			return true;
		})
		.map((f) => ({
			...f,
			content: f.content.trim(),
			subject: f.subject?.trim(),
			context: f.context?.trim(),
			importance:
				typeof f.importance === "number"
					? Math.max(1, Math.min(5, Math.round(f.importance)))
					: importance,
			permanent: f.permanent === true,
		}));

	// Validate personality signals
	let personalitySignals = raw.personalitySignals;
	if (personalitySignals?.traitChanges) {
		const validChanges = personalitySignals.traitChanges
			.filter(
				(c) =>
					c.trait &&
					typeof c.trait === "string" &&
					VALID_TRAIT_NAMES.has(c.trait.toLowerCase().trim()) &&
					typeof c.delta === "number" &&
					Math.abs(c.delta) >= 0.01 &&
					c.reason &&
					typeof c.reason === "string",
			)
			.map((c) => ({
				trait: c.trait.toLowerCase().trim(),
				delta: Math.max(-0.15, Math.min(0.15, c.delta)),
				reason: c.reason.trim(),
			}));
		personalitySignals =
			validChanges.length > 0 ? { traitChanges: validChanges } : undefined;
	} else {
		personalitySignals = undefined;
	}

	return { summary, importance, facts, personalitySignals };
}
