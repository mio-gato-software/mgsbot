import * as fs from "node:fs";
import {
	type Content,
	createPartFromUri,
	createUserContent,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import type { MemoryEvaluation } from "./types.ts";
import { executeWeatherFunction, weatherTool } from "./weather.ts";

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
	contents: Content[],
): Promise<string> {
	if (isDev)
		console.log(
			"[generateResponse] Calling model with",
			contents.length,
			"content entries",
		);
	const response = await ai.models.generateContent({
		model: MODEL,
		config: {
			systemInstruction: systemPrompt,
			tools: [{ functionDeclarations: [weatherTool] }],
		},
		contents,
	});
	logTokenUsage("generateResponse", response);

	const functionCalls = response.functionCalls;
	if (functionCalls && functionCalls.length > 0) {
		const call = functionCalls[0];
		if (call.name === "get_current_weather") {
			if (isDev)
				console.log("[generateResponse] Function call: get_current_weather");
			const weatherResult = await executeWeatherFunction();
			if (isDev)
				console.log("[generateResponse] Weather result:", weatherResult);

			const modelParts = response.candidates?.[0]?.content?.parts ?? [];
			const followUp: Content[] = [
				...contents,
				{
					role: "model",
					parts: modelParts,
				},
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								name: call.name,
								response: { result: weatherResult },
							},
						},
					],
				},
			];

			const followUpResponse = await ai.models.generateContent({
				model: MODEL,
				config: {
					systemInstruction: systemPrompt,
					tools: [{ functionDeclarations: [weatherTool] }],
				},
				contents: followUp,
			});
			logTokenUsage("generateResponse:followUp", followUpResponse);
			const text = followUpResponse.text ?? "";
			if (isDev)
				console.log(
					"[generateResponse] Follow-up response:",
					text.slice(0, 200),
				);
			return text;
		}
	}

	const text = response.text ?? "";
	if (isDev) console.log("[generateResponse] Response:", text.slice(0, 200));
	return text;
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

export async function generateImage(
	prompt: string,
	referenceImagePath: string,
): Promise<Buffer> {
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
				text: `This is a reference image of a character. Generate a new image of this same character (same face, body features, and art style) but with a completely different outfit, pose, and setting. The scene: ${prompt}. The current local time is ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Santo_Domingo" })} — the setting and atmosphere should feel natural for this time of day (e.g. late night could be cozy in bed, at a bar, watching TV; morning could be having coffee, getting ready; afternoon could be at a mall, working, etc.). Only the character's identity should match the reference — everything else should be new and fit the scene.`,
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

export async function evaluateMemory(
	recentMessages: string,
): Promise<MemoryEvaluation> {
	const prompt = `Analiza el siguiente extracto de conversación. Haz dos cosas:

1. **Memorias generales**: información compartida que vale la pena recordar a largo plazo (hechos, preferencias, eventos importantes, decisiones, etc.).
2. **Hechos por miembro**: datos personales sobre personas específicas mencionadas en la conversación (eventos de vida, trabajo, preferencias, logros, relaciones, etc.). Usa un key corto en español para cada hecho (ej: "estado-civil", "empleo", "telefono", "hobby", "mascota"). Si un hecho actualiza algo previo, usa el mismo key para reemplazarlo. Identifica a los miembros por sus nombres tal como aparecen en la conversación.

Responde SOLO con JSON válido en este formato exacto:
{"save": boolean, "memories": [{"content": "qué recordar", "context": "por qué importa", "importance": N}], "memberFacts": [{"member": "Nombre", "key": "tema", "content": "el hecho completo"}]}

Donde importance es 1-5 (1=trivial, 5=crítico).
Si no hay nada que recordar: {"save": false, "memories": [], "memberFacts": []}

Conversación:
${recentMessages}`;

	const response = await ai.models.generateContent({
		model: MODEL,
		contents: createUserContent([prompt]),
	});

	logTokenUsage("evaluateMemory", response);
	const text =
		response.text ?? '{"save": false, "memories": [], "memberFacts": []}';
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
