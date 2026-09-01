import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "../logger.ts";
import type { TtsProvider } from "./types.ts";

const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_API_VERSION = "2026-08-14";
const DEFAULT_CARTESIA_MODEL = "sonic-3.6";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function nonBlank(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

interface CartesiaTtsProviderOptions {
	apiKey?: string;
	voiceId?: string;
	model?: string;
	language?: string;
	fetchImpl?: FetchLike;
	outputDir?: string;
	now?: () => number;
}

export class CartesiaTtsProvider implements TtsProvider {
	readonly name = "cartesia";
	private readonly apiKey: string;
	private readonly voiceId: string;
	private readonly model: string;
	private readonly language?: string;
	private readonly fetchImpl: FetchLike;
	private readonly outputDir: string;
	private readonly now: () => number;

	constructor(options: CartesiaTtsProviderOptions = {}) {
		const apiKey = options.apiKey ?? process.env.CARTESIA_API_KEY;
		if (!apiKey) throw new Error("CARTESIA_API_KEY is required");
		const voiceId = options.voiceId ?? process.env.CARTESIA_VOICE_ID;
		if (!voiceId) throw new Error("CARTESIA_VOICE_ID is required");

		this.apiKey = apiKey;
		this.voiceId = voiceId;
		this.model =
			nonBlank(options.model) ??
			nonBlank(process.env.CARTESIA_MODEL) ??
			DEFAULT_CARTESIA_MODEL;
		this.language =
			nonBlank(options.language) ?? nonBlank(process.env.CARTESIA_LANGUAGE);
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.outputDir = options.outputDir ?? "./audios";
		this.now = options.now ?? Date.now;
	}

	async synthesize(text: string): Promise<string> {
		log.debug(
			"[TTS:cartesia] Generating speech, voice:",
			this.voiceId,
			"model:",
			this.model,
		);

		const body = {
			model_id: this.model,
			transcript: text,
			voice: this.voiceId,
			output_format: {
				container: "mp3",
				sample_rate: 44100,
				bit_rate: 128000,
			},
			...(this.language ? { language: this.language } : {}),
		};
		const response = await this.fetchImpl(CARTESIA_TTS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Cartesia-Version": CARTESIA_API_VERSION,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});

		if (!response.ok) {
			const errorBody = (await response.text().catch(() => "")).slice(0, 1000);
			throw new Error(
				`Cartesia TTS failed: ${response.status} ${response.statusText} ${errorBody}`.trim(),
			);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const filePath = join(
			this.outputDir,
			`tts_cartesia_${this.now()}_${randomUUID()}.mp3`,
		);
		await Bun.write(filePath, buffer);
		log.debug("[TTS:cartesia] Received bytes:", buffer.byteLength);
		return filePath;
	}
}
