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
import { getOpenAIClient, openaiReasoningConfig } from "./openai-client.ts";
import {
	hasGoogleApiKey,
	resolveGeminiVisionModel,
	resolveOpenAIVisionModel,
	resolveVisionProvider,
	resolveYouTubeProvider,
	supportProviderHasKey,
} from "./platform.ts";

export const DESCRIBE_IMAGE_PROMPT =
	"The user sent this image. Describe what you see briefly so you can reference it in conversation.";

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

async function describeImageWithGemini(
	base64Data: string,
	mimeType: string,
	caption?: string,
): Promise<string> {
	const parts: Part[] = [
		{ inlineData: { mimeType, data: base64Data } },
		{ text: describeImagePrompt(caption) },
	];
	const response = await withRetry(() =>
		getAI().models.generateContent({
			model: resolveGeminiVisionModel(),
			contents: createUserContent(parts),
		}),
	);
	logTokenUsage("describeImage", response);
	return response.text ?? "[image description failed]";
}

async function describeImageWithOpenAI(
	base64Data: string,
	mimeType: string,
	caption?: string,
): Promise<string> {
	const response = await withRetry(() =>
		getOpenAIClient().responses.create({
			model: resolveOpenAIVisionModel(),
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: describeImagePrompt(caption) },
						{
							type: "input_image",
							image_url: `data:${mimeType};base64,${base64Data}`,
							detail: "auto",
						},
					],
				},
			],
			...openaiReasoningConfig(resolveOpenAIVisionModel()),
		}),
	);
	return response.output_text ?? "[image description failed]";
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
					`[describeImage] Provider ${provider.name} failed, falling back to configured vision provider:`,
					error,
				);
			}
		}

		const visionProvider = resolveVisionProvider();
		if (supportProviderHasKey(visionProvider)) {
			log.debug(`[describeImage] Using ${visionProvider}, mimeType:`, mimeType);
			const text =
				visionProvider === "openai"
					? await describeImageWithOpenAI(base64Data, mimeType, caption)
					: await describeImageWithGemini(base64Data, mimeType, caption);
			log.debug("[describeImage] Result:", text.slice(0, 200));
			return text;
		}

		log.error("[describeImage] No vision provider available");
		return "[image description failed]";
	} catch (error) {
		log.error("[describeImage] Error:", error);
		return "[image description failed]";
	}
}

export async function analyzeYouTube(
	videoUrl: string,
	userQuestion?: string,
): Promise<string> {
	if (resolveYouTubeProvider() !== "gemini" || !hasGoogleApiKey()) {
		log.warn(
			"[analyzeYouTube] YouTube analysis is Gemini-only and requires GOOGLE_API_KEY.",
		);
		return "[video analysis unavailable without GOOGLE_API_KEY]";
	}

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
			model: resolveGeminiVisionModel(),
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
