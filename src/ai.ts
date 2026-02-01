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
		},
		contents,
	});
	logTokenUsage("generateResponse", response);
	const text = response.text ?? "";
	if (isDev) console.log("[generateResponse] Response:", text.slice(0, 200));
	return text;
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

	logTokenUsage("evaluateMemory", response);
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
