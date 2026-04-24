import { resolveTtsProviderName } from "../provider-options.ts";
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

	const providerName = resolveTtsProviderName();

	if (providerName === "elevenlabs") {
		cachedProvider = new ElevenLabsTtsProvider();
	} else if (providerName === "inworld") {
		cachedProvider = new InworldTtsProvider();
	} else if (providerName === "lemonfox") {
		cachedProvider = new LemonFoxTtsProvider();
	} else if (providerName === "fal") {
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
