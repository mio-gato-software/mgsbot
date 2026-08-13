import { log } from "../logger.ts";
import type { TtsProvider } from "./types.ts";

export class InworldTtsProvider implements TtsProvider {
	readonly name = "inworld";
	private apiKey: string;
	private voiceId: string;

	constructor() {
		const apiKey = process.env.INWORLD_API_KEY;
		if (!apiKey) throw new Error("INWORLD_API_KEY is required");
		this.apiKey = apiKey;
		const voiceId = process.env.INWORLD_VOICE_ID;
		if (!voiceId) throw new Error("INWORLD_VOICE_ID is required");
		this.voiceId = voiceId;
	}

	async synthesize(text: string): Promise<string> {
		log.debug("[TTS:inworld] Generating speech, voice:", this.voiceId);

		const response = await fetch("https://api.inworld.ai/tts/v1/voice", {
			method: "POST",
			headers: {
				Authorization: `Basic ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				text,
				voiceId: this.voiceId,
				modelId: process.env.INWORLD_MODEL || "inworld-tts-1.5-max",
				audioConfig: {
					audioEncoding: "MP3",
				},
				temperature: 1,
				applyTextNormalization: "ON",
			}),
			signal: AbortSignal.timeout(15000),
		});

		log.debug("[TTS:inworld] Response status:", response.status);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`Inworld TTS failed: ${response.status} ${errorBody}`);
		}

		const data = (await response.json()) as {
			audioContent: string;
			usage?: { processedCharactersCount: number; modelId: string };
		};

		if (data.usage)
			log.debug(
				"[TTS:inworld] Processed chars:",
				data.usage.processedCharactersCount,
			);

		const audioBuffer = Buffer.from(data.audioContent, "base64");
		const filePath = `./audios/tts_${Date.now()}.mp3`;
		await Bun.write(filePath, audioBuffer);
		log.debug("[TTS:inworld] Saved bytes:", audioBuffer.byteLength);
		return filePath;
	}
}
