import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const isDev = process.env.NODE_ENV === "development";

type TtsProvider = "elevenlabs" | "lemonfox";

function resolveTtsProvider(): TtsProvider | null {
	const explicit = process.env.TTS_PROVIDER?.toLowerCase();
	if (explicit === "elevenlabs" || explicit === "lemonfox") return explicit;

	if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
	if (process.env.LEMON_FOX_API_KEY) return "lemonfox";
	return null;
}

const ttsProvider = resolveTtsProvider();

export function isTtsAvailable(): boolean {
	return ttsProvider !== null;
}

export function getTtsProviderName(): string | null {
	return ttsProvider;
}

async function elevenLabsTts(text: string): Promise<string> {
	const client = new ElevenLabsClient({
		apiKey: process.env.ELEVENLABS_API_KEY,
	});
	const voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

	if (isDev) console.log("[TTS:elevenlabs] Generating speech, voice:", voiceId);

	const audio = await client.textToSpeech.convert(voiceId, {
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
	if (isDev) console.log("[TTS:elevenlabs] Received bytes:", buffer.byteLength);
	await Bun.write(filePath, buffer);
	return filePath;
}

async function lemonFoxTts(text: string): Promise<string> {
	if (isDev)
		console.log(
			"[TTS:lemonfox] API key present:",
			!!process.env.LEMON_FOX_API_KEY,
		);

	const response = await fetch("https://api.lemonfox.ai/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.LEMON_FOX_API_KEY}`,
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

export async function textToSpeech(text: string): Promise<string> {
	if (!ttsProvider) {
		throw new Error("No TTS provider configured");
	}

	if (ttsProvider === "elevenlabs") {
		return elevenLabsTts(text);
	}
	return lemonFoxTts(text);
}
