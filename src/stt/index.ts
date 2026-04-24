import { resolveSttProviderOrder } from "../provider-options.ts";
import { FalSttProvider } from "./fal.ts";
import { GeminiSttProvider } from "./gemini.ts";
import { LemonFoxSttProvider } from "./lemonfox.ts";
import type { SttProvider } from "./types.ts";

export type { SttProvider } from "./types.ts";

let cachedProvider: SttProvider | null = null;
let resolved = false;

function tryBuild(name: string, build: () => SttProvider): SttProvider | null {
	try {
		return build();
	} catch (error) {
		console.warn(`[stt] Could not initialize ${name}:`, error);
		return null;
	}
}

function createSttProvider(): SttProvider | null {
	if (resolved) return cachedProvider;
	resolved = true;

	const order = resolveSttProviderOrder();

	for (const candidate of order) {
		if (candidate === "fal") {
			cachedProvider = tryBuild("fal", () => new FalSttProvider());
		} else if (candidate === "lemonfox") {
			cachedProvider = tryBuild("lemonfox", () => new LemonFoxSttProvider());
		} else {
			cachedProvider = tryBuild("gemini", () => new GeminiSttProvider());
		}
		if (cachedProvider) break;
	}

	if (cachedProvider) {
		console.log(`[stt] Using provider: ${cachedProvider.name}`);
	}

	return cachedProvider;
}

export function isSttAvailable(): boolean {
	return createSttProvider() !== null;
}

export function getSttProviderName(): string | null {
	return createSttProvider()?.name ?? null;
}

export async function transcribeAudio(
	filePath: string,
	mimeType: string,
): Promise<string> {
	const provider = createSttProvider();
	if (!provider) {
		console.error("[stt] No STT provider available");
		return "[transcription failed]";
	}
	try {
		return await provider.transcribe(filePath, mimeType);
	} catch (error) {
		console.error(`[stt:${provider.name}] Error:`, error);
		return "[transcription failed]";
	}
}
