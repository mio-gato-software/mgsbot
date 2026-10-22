import {
	createPartFromUri,
	createUserContent,
	type GoogleGenAI,
} from "@google/genai";
import { createGoogleClient } from "../ai/google-client.ts";
import { resolveGeminiSttModel } from "../ai/platform.ts";
import { log } from "../logger.ts";
import { abortableDelay } from "../operation-deadline.ts";
import { isTutorActive } from "../prompt/modes.ts";
import { withRetry } from "../utils.ts";
import type { SttProvider } from "./types.ts";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
	if (!_ai) _ai = createGoogleClient();
	return _ai;
}

export class GeminiSttProvider implements SttProvider {
	readonly name = "gemini";

	constructor(private readonly client?: GoogleGenAI) {}

	async transcribe(filePath: string, mimeType: string): Promise<string> {
		log.debug("[STT:gemini] Transcribing");
		const ai = this.client ?? getAI();

		const uploaded = await ai.files.upload({
			file: filePath,
			config: { mimeType },
		});

		try {
			log.debug("[STT:gemini] Upload result:", {
				name: uploaded.name,
				uri: uploaded.uri,
				state: uploaded.state,
				mimeType: uploaded.mimeType,
			});

			// Poll until the file is ACTIVE
			const MAX_POLL_ATTEMPTS = 20;
			const POLL_INTERVAL_MS = 1000;
			let fileState = uploaded.state;

			for (
				let i = 0;
				i < MAX_POLL_ATTEMPTS && fileState === "PROCESSING";
				i++
			) {
				log.debug(
					`[STT:gemini] Polling file state (${i + 1}/${MAX_POLL_ATTEMPTS})...`,
				);
				await abortableDelay(POLL_INTERVAL_MS);
				const fileInfo = await ai.files.get({ name: uploaded.name ?? "" });
				fileState = fileInfo.state;
			}

			if (fileState !== "ACTIVE") {
				log.error(
					`[STT:gemini] File never became ACTIVE (state: ${fileState})`,
				);
				throw new Error(`Gemini file upload failed: state=${fileState}`);
			}

			log.debug("[STT:gemini] File is ACTIVE, generating transcription...");

			const response = await withRetry(() =>
				ai.models.generateContent({
					model: resolveGeminiSttModel(),
					contents: createUserContent([
						createPartFromUri(uploaded.uri ?? "", uploaded.mimeType ?? ""),
						isTutorActive()
							? "Transcribe this audio exactly as spoken. The speaker is practicing English, so the audio is most likely in English. Return ONLY the transcription, nothing else."
							: "Transcribe this audio exactly as spoken, preserving the original language. The speaker is most likely speaking Spanish, but may occasionally switch to English (code-switching is allowed within a single utterance). Do NOT translate — if they speak Spanish, output Spanish; if they speak English, output English. Return ONLY the transcription, nothing else.",
					]),
				}),
			);

			const text = response.text ?? "";
			log.debug("[STT:gemini] Result:", text.slice(0, 200));
			return text;
		} finally {
			if (uploaded.name) {
				await ai.files.delete({ name: uploaded.name }).catch((error) => {
					log.warn("[STT:gemini] Remote file cleanup failed:", error);
				});
			}
		}
	}
}
