import type { TtsProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

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
		if (isDev)
			console.log("[TTS:inworld] Generating speech, voice:", this.voiceId);

		const response = await fetch("https://api.inworld.ai/tts/v1/voice", {
			method: "POST",
			headers: {
				Authorization: this.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				text,
				voiceId: this.voiceId,
				modelId: "inworld-tts-1.5-max",
				audioConfig: {
					audioEncoding: "LINEAR16",
					sampleRateHertz: 22050,
				},
				temperature: 1,
				applyTextNormalization: "ON",
			}),
			signal: AbortSignal.timeout(15000),
		});

		if (isDev) console.log("[TTS:inworld] Response status:", response.status);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`Inworld TTS failed: ${response.status} ${errorBody}`);
		}

		const data = (await response.json()) as {
			audioContent: string;
			usage?: { processedCharactersCount: number; modelId: string };
		};

		if (isDev && data.usage)
			console.log(
				"[TTS:inworld] Processed chars:",
				data.usage.processedCharactersCount,
			);

		const audioBuffer = Buffer.from(data.audioContent, "base64");
		const filePath = `./audios/tts_${Date.now()}.wav`;
		await Bun.write(filePath, audioBuffer);
		if (isDev)
			console.log("[TTS:inworld] Saved bytes:", audioBuffer.byteLength);
		return filePath;
	}
}
