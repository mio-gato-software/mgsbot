import { isTutorActive } from "../tutor.ts";
import type { SttProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

export class FalSttProvider implements SttProvider {
	readonly name = "fal";
	private apiKey: string;

	constructor() {
		const apiKey = process.env.FAL_API_KEY;
		if (!apiKey) throw new Error("FAL_API_KEY is required");
		this.apiKey = apiKey;
	}

	async transcribe(filePath: string, mimeType: string): Promise<string> {
		if (isDev) console.log("[STT:fal] Transcribing with Scribe v2");

		const fileBuffer = await Bun.file(filePath).arrayBuffer();
		const base64Data = Buffer.from(fileBuffer).toString("base64");
		const audioUrl = `data:${mimeType};base64,${base64Data}`;

		const body: Record<string, unknown> = {
			audio_url: audioUrl,
			diarize: false,
			tag_audio_events: false,
		};

		if (isTutorActive()) {
			body.language_code = "eng";
		}

		const response = await fetch(
			"https://fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2",
			{
				method: "POST",
				headers: {
					Authorization: `Key ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`fal.ai STT failed: ${response.status} ${errorBody}`);
		}

		const data = (await response.json()) as { text?: string };
		const text = data.text?.trim();
		if (!text) throw new Error("fal.ai STT returned empty text");
		if (isDev) console.log("[STT:fal] Result:", text.slice(0, 200));
		return text;
	}
}
