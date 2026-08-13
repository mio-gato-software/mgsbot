import { toFile } from "openai";
import { getOpenAIClient } from "../ai/openai-client.ts";
import { resolveOpenAISttModel } from "../ai/platform.ts";
import { log } from "../logger.ts";
import { isTutorActive } from "../prompt/modes.ts";
import type { SttProvider } from "./types.ts";

export class OpenAISttProvider implements SttProvider {
	readonly name = "openai";

	async transcribe(filePath: string, mimeType?: string): Promise<string> {
		const model = resolveOpenAISttModel();
		log.debug("[STT:openai] Transcribing with", model);

		const file = await toFile(Bun.file(filePath).stream(), "audio.ogg", {
			type: mimeType || "audio/ogg",
		});
		const response = await getOpenAIClient().audio.transcriptions.create({
			file,
			model,
			...(isTutorActive() ? { language: "en" } : {}),
		});

		const text = response.text?.trim() ?? "";
		log.debug("[STT:openai] Result:", text.slice(0, 200));
		return text;
	}
}
