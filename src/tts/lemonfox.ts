import type { TtsProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

export class LemonFoxTtsProvider implements TtsProvider {
	readonly name = "lemonfox";
	private apiKey: string;

	constructor() {
		const apiKey = process.env.LEMON_FOX_API_KEY;
		if (!apiKey) throw new Error("LEMON_FOX_API_KEY is required");
		this.apiKey = apiKey;
	}

	async synthesize(text: string): Promise<string> {
		if (isDev) console.log("[TTS:lemonfox] Generating speech");

		const response = await fetch("https://api.lemonfox.ai/v1/audio/speech", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				input: text,
				voice: "heart",
				response_format: "mp3",
			}),
			signal: AbortSignal.timeout(15000),
		});

		if (isDev) console.log("[TTS:lemonfox] Response status:", response.status);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`LemonFox TTS failed: ${response.status} ${errorBody}`);
		}

		const filePath = `./audios/tts_${Date.now()}.mp3`;
		const arrayBuffer = await response.arrayBuffer();
		if (isDev)
			console.log("[TTS:lemonfox] Received bytes:", arrayBuffer.byteLength);
		await Bun.write(filePath, new Uint8Array(arrayBuffer));
		return filePath;
	}
}
