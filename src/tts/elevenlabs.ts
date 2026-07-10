import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { log } from "../logger.ts";
import type { TtsProvider } from "./types.ts";

export class ElevenLabsTtsProvider implements TtsProvider {
	readonly name = "elevenlabs";
	private client: ElevenLabsClient;
	private voiceId: string;

	constructor() {
		const apiKey = process.env.ELEVENLABS_API_KEY;
		if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required");
		this.client = new ElevenLabsClient({ apiKey });
		this.voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
	}

	async synthesize(text: string): Promise<string> {
		log.debug("[TTS:elevenlabs] Generating speech, voice:", this.voiceId);

		const audio = await this.client.textToSpeech.convert(this.voiceId, {
			text,
			modelId: "eleven_v3",
			outputFormat: "mp3_44100_128",
		});

		const filePath = `./audios/tts_${Date.now()}.mp3`;
		const chunks: Uint8Array[] = [];
		for await (const chunk of audio) {
			chunks.push(chunk);
		}
		const buffer = Buffer.concat(chunks);
		log.debug("[TTS:elevenlabs] Received bytes:", buffer.byteLength);
		await Bun.write(filePath, buffer);
		return filePath;
	}
}
