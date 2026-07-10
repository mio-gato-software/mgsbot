import * as fs from "node:fs";
import {
	createUserContent,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import { log } from "../logger.ts";
import { createChatProvider } from "../providers/index.ts";
import { supportsVision } from "../providers/types.ts";
import { withRetry } from "../utils.ts";

const MODEL = "gemini-3-flash-preview";

export const DESCRIBE_IMAGE_PROMPT =
	"The user sent this image. Describe what you see briefly so you can reference it in conversation.";

// Shared across vision-capable providers so the prompt stays consistent.
export function describeImagePrompt(caption?: string): string {
	return caption
		? `The user sent this image with the caption: "${caption}". Describe what you see briefly so you can reference it in conversation.`
		: DESCRIBE_IMAGE_PROMPT;
}

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}

function logTokenUsage(label: string, response: GenerateContentResponse): void {
	const usage = response.usageMetadata;
	if (!usage) return;
	log.info(
		`[tokens:${label}] in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`,
	);
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
			log.debug(
				`[describeImage] Using provider: ${provider.name} (${provider.model})`,
			);
			try {
				return await provider.describeImage(base64Data, mimeType, caption);
			} catch (error) {
				log.error(
					`[describeImage] Provider ${provider.name} failed, falling back to Gemini:`,
					error,
				);
			}
		}

		log.debug("[describeImage] Using Gemini, mimeType:", mimeType);

		const parts: Part[] = [
			{ inlineData: { mimeType, data: base64Data } },
			{ text: describeImagePrompt(caption) },
		];

		const response = await withRetry(() =>
			getAI().models.generateContent({
				model: MODEL,
				contents: createUserContent(parts),
			}),
		);

		logTokenUsage("describeImage", response);
		const text = response.text ?? "[image description failed]";
		log.debug("[describeImage] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		log.error("[describeImage] Error:", error);
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
			: "The user shared this YouTube video. Briefly describe what the video is about in the user's language so you can reference it in conversation.";

		const parts: Part[] = [
			{ fileData: { fileUri: videoUrl } },
			{ text: prompt },
		];

		log.debug("[analyzeYouTube] URL:", videoUrl);

		const response = await getAI().models.generateContent({
			model: MODEL,
			contents: createUserContent(parts),
		});

		logTokenUsage("analyzeYouTube", response);
		const text = response.text ?? "[video analysis failed]";
		log.debug("[analyzeYouTube] Result:", text.slice(0, 200));
		return text;
	} catch (error) {
		log.error("[analyzeYouTube] Error:", error);
		return "[video analysis failed]";
	}
}
