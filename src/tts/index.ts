import { ElevenLabsTtsProvider } from "./elevenlabs.ts";
import { FalTtsProvider } from "./fal.ts";
import { InworldTtsProvider } from "./inworld.ts";
import { LemonFoxTtsProvider } from "./lemonfox.ts";
import type { TtsProvider } from "./types.ts";

export type { TtsProvider } from "./types.ts";

let cachedProvider: TtsProvider | null = null;
let resolved = false;

function createTtsProvider(): TtsProvider | null {
	if (resolved) return cachedProvider;
	resolved = true;

	const explicit = process.env.TTS_PROVIDER?.toLowerCase();

	if (
		explicit === "elevenlabs" ||
		(!explicit && process.env.ELEVENLABS_API_KEY)
	) {
		cachedProvider = new ElevenLabsTtsProvider();
	} else if (
		explicit === "inworld" ||
		(!explicit && process.env.INWORLD_API_KEY)
	) {
		cachedProvider = new InworldTtsProvider();
	} else if (
		explicit === "lemonfox" ||
		(!explicit && process.env.LEMON_FOX_API_KEY)
	) {
		cachedProvider = new LemonFoxTtsProvider();
	} else if (explicit === "fal") {
		cachedProvider = new FalTtsProvider();
	}

	if (cachedProvider) {
		console.log(`[tts] Using provider: ${cachedProvider.name}`);
	}

	return cachedProvider;
}

export function isTtsAvailable(): boolean {
	return createTtsProvider() !== null;
}

export function getTtsProviderName(): string | null {
	return createTtsProvider()?.name ?? null;
}

export async function textToSpeech(text: string): Promise<string> {
	const provider = createTtsProvider();
	if (!provider) throw new Error("No TTS provider configured");
	return provider.synthesize(text);
}
