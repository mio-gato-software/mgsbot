import { log } from "../logger.ts";
import { requestSignal } from "../operation-deadline.ts";
import { isTutorActive } from "../prompt/modes.ts";
import { ProviderHttpError } from "../provider-http-error.ts";
import type { SttProvider } from "./types.ts";

export class LemonFoxSttProvider implements SttProvider {
	readonly name = "lemonfox";
	private apiKey: string;

	constructor() {
		const apiKey = process.env.LEMON_FOX_API_KEY;
		if (!apiKey) throw new Error("LEMON_FOX_API_KEY is required");
		this.apiKey = apiKey;
	}

	async transcribe(filePath: string): Promise<string> {
		log.debug("[STT:lemonfox] Transcribing");

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
				signal: requestSignal(30_000),
			},
		);

		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new ProviderHttpError("LemonFox STT failed", response.status);
		}

		const data = (await response.json()) as { text?: string };
		const text = data.text?.trim();
		if (!text) throw new Error("LemonFox STT returned empty text");

		return text;
	}
}
