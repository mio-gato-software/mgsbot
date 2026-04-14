import { isTutorActive } from "../tutor.ts";
import type { SttProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

export class LemonFoxSttProvider implements SttProvider {
	readonly name = "lemonfox";
	private apiKey: string;

	constructor() {
		const apiKey = process.env.LEMON_FOX_API_KEY;
		if (!apiKey) throw new Error("LEMON_FOX_API_KEY is required");
		this.apiKey = apiKey;
	}

	async transcribe(filePath: string): Promise<string> {
		if (isDev) console.log("[STT:lemonfox] Transcribing");

		const fileBuffer = await Bun.file(filePath).arrayBuffer();
		const fileName = filePath.split("/").pop() ?? "audio.ogg";

		const body = new FormData();
		body.append("file", new Blob([fileBuffer]), fileName);
		body.append("response_format", "json");
		if (isTutorActive()) {
			body.append("language", "en");
		}

		const response = await fetch(
			"https://api.lemonfox.ai/v1/audio/transcriptions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
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
		if (isDev) console.log("[STT:lemonfox] Result:", text.slice(0, 200));
		return text;
	}
}
