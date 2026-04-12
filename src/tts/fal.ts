import type { TtsProvider } from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

interface FalTtsResponse {
	audio?: {
		url: string;
	};
}

export class FalTtsProvider implements TtsProvider {
	readonly name = "fal";
	private readonly apiKey: string;
	private readonly voice: string;

	constructor(voice?: string) {
		const apiKey = process.env.FAL_API_KEY;
		if (!apiKey) throw new Error("FAL_API_KEY is required for fal TTS");
		this.apiKey = apiKey;
		this.voice = voice ?? process.env.FAL_VOICE ?? "Sarah";
	}

	async synthesize(text: string): Promise<string> {
		if (isDev) console.log("[TTS:fal] Generating speech, voice:", this.voice);

		const response = await fetch(
			"https://fal.run/fal-ai/elevenlabs/tts/eleven-v3",
			{
				method: "POST",
				headers: {
					Authorization: `Key ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					text,
					voice: this.voice,
					stability: 0.5,
					language_code: "en",
				}),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(
				`fal.ai TTS error: ${response.status} ${response.statusText} ${errorBody}`,
			);
		}

		const data = (await response.json()) as FalTtsResponse;
		const audioUrl = data.audio?.url;
		if (!audioUrl) {
			throw new Error("fal.ai TTS returned no audio URL");
		}

		// Download the audio file
		const audioResponse = await fetch(audioUrl, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!audioResponse.ok) {
			throw new Error(
				`Failed to download fal.ai TTS audio: ${audioResponse.status}`,
			);
		}

		const filePath = `./audios/tts_fal_${Date.now()}.mp3`;
		const buffer = Buffer.from(await audioResponse.arrayBuffer());
		if (isDev) console.log("[TTS:fal] Received bytes:", buffer.byteLength);
		await Bun.write(filePath, buffer);
		return filePath;
	}
}
