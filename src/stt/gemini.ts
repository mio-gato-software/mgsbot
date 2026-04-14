import {
	createPartFromUri,
	createUserContent,
	GoogleGenAI,
} from "@google/genai";
import { isTutorActive } from "../tutor.ts";
import { withRetry } from "../utils.ts";
import type { SttProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";
const MODEL = "gemini-3-flash-preview";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = new GoogleGenAI({});
	return _ai;
}

export class GeminiSttProvider implements SttProvider {
	readonly name = "gemini";

	async transcribe(filePath: string, mimeType: string): Promise<string> {
		if (isDev) console.log("[STT:gemini] Transcribing");

		const uploaded = await getAI().files.upload({
			file: filePath,
			config: { mimeType },
		});

		if (isDev) {
			console.log("[STT:gemini] Upload result:", {
				name: uploaded.name,
				uri: uploaded.uri,
				state: uploaded.state,
				mimeType: uploaded.mimeType,
			});
		}

		// Poll until the file is ACTIVE
		const MAX_POLL_ATTEMPTS = 20;
		const POLL_INTERVAL_MS = 1000;
		let fileState = uploaded.state;

		for (let i = 0; i < MAX_POLL_ATTEMPTS && fileState === "PROCESSING"; i++) {
			if (isDev)
				console.log(
					`[STT:gemini] Polling file state (${i + 1}/${MAX_POLL_ATTEMPTS})...`,
				);
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			const fileInfo = await getAI().files.get({ name: uploaded.name ?? "" });
			fileState = fileInfo.state;
		}

		if (fileState !== "ACTIVE") {
			console.error(
				`[STT:gemini] File never became ACTIVE (state: ${fileState})`,
			);
			throw new Error(`Gemini file upload failed: state=${fileState}`);
		}

		if (isDev)
			console.log("[STT:gemini] File is ACTIVE, generating transcription...");

		const response = await withRetry(() =>
			getAI().models.generateContent({
				model: MODEL,
				contents: createUserContent([
					createPartFromUri(uploaded.uri ?? "", uploaded.mimeType ?? ""),
					isTutorActive()
						? "Transcribe this audio exactly as spoken. The speaker is practicing English, so the audio is most likely in English. Return ONLY the transcription, nothing else."
						: "Transcribe this audio exactly as spoken, in the original language. Return ONLY the transcription, nothing else.",
				]),
			}),
		);

		const text = response.text ?? "";
		if (isDev) console.log("[STT:gemini] Result:", text.slice(0, 200));
		return text;
	}
}
