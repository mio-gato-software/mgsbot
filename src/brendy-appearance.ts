import * as fs from "node:fs";
import { createUserContent, GoogleGenAI, type Part } from "@google/genai";

const isDev = process.env.NODE_ENV === "development";

const POSSIBLE_PATHS = [
	"./memory/brendy-base.png",
	"./memory/brendy-base.jpg",
	"./memory/brendy-base.jpeg",
];

let cachedAppearance: string | null = null;

export async function getBrendyAppearance(): Promise<string> {
	if (cachedAppearance !== null) return cachedAppearance;

	const basePath = POSSIBLE_PATHS.find((p) => fs.existsSync(p));
	if (!basePath) {
		console.warn(
			"[brendy-appearance] No base photo found at memory/brendy-base.{png,jpg,jpeg}",
		);
		cachedAppearance = "";
		return cachedAppearance;
	}

	try {
		const ext = basePath.split(".").pop() ?? "png";
		const mimeType = ext === "png" ? "image/png" : "image/jpeg";
		const base64Data = fs.readFileSync(basePath, { encoding: "base64" });

		const ai = new GoogleGenAI({});
		const parts: Part[] = [
			{ inlineData: { mimeType, data: base64Data } },
			{
				text: "Describe this person's physical appearance in detail for use as an image generation prompt. Include hair color and style, skin tone, eye color, body type, and any distinctive features. Write in English, as a concise visual description suitable for an image generation model. Do NOT include any background or clothing description.",
			},
		];

		const response = await ai.models.generateContent({
			model: "gemini-3-flash-preview",
			contents: createUserContent(parts),
		});

		cachedAppearance = response.text ?? "";
		if (isDev)
			console.log(
				"[brendy-appearance] Cached appearance:",
				cachedAppearance.slice(0, 200),
			);
		return cachedAppearance;
	} catch (error) {
		console.error("[brendy-appearance] Error analyzing base photo:", error);
		cachedAppearance = "";
		return cachedAppearance;
	}
}
