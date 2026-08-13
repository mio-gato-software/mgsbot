import { getOpenAIClient } from "../ai/openai-client.ts";
import {
	resolveOpenAITtsModel,
	resolveOpenAITtsVoice,
} from "../ai/platform.ts";
import { log } from "../logger.ts";
import type { TtsProvider } from "./types.ts";

export class OpenAITtsProvider implements TtsProvider {
	readonly name = "openai";

	async synthesize(text: string): Promise<string> {
		const model = resolveOpenAITtsModel();
		const voice = resolveOpenAITtsVoice();
		log.debug("[TTS:openai] Generating speech, voice:", voice, "model:", model);

		const audio = await getOpenAIClient().audio.speech.create({
			model,
			voice: voice as "coral",
			input: text,
			response_format: "mp3",
		});

		const filePath = `./audios/tts_${Date.now()}.mp3`;
		const buffer = Buffer.from(await audio.arrayBuffer());
		log.debug("[TTS:openai] Received bytes:", buffer.byteLength);
		await Bun.write(filePath, buffer);
		return filePath;
	}
}
