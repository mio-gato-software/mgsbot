import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoogleGenAI } from "@google/genai";
import { withDeadline } from "../src/operation-deadline.ts";
import * as modes from "../src/prompt/modes.ts";
import {
	defaultResponseDependencies,
	sendResponse,
} from "../src/response-processor.ts";
import { FalSttProvider } from "../src/stt/fal.ts";
import { GeminiSttProvider } from "../src/stt/gemini.ts";
import { LemonFoxSttProvider } from "../src/stt/lemonfox.ts";
import { OpenAISttProvider } from "../src/stt/openai.ts";
import { ElevenLabsTtsProvider } from "../src/tts/elevenlabs.ts";
import { FalTtsProvider } from "../src/tts/fal.ts";
import { InworldTtsProvider } from "../src/tts/inworld.ts";
import { LemonFoxTtsProvider } from "../src/tts/lemonfox.ts";
import { OpenAITtsProvider } from "../src/tts/openai.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

const originalFetch = globalThis.fetch;
const settings = {
	OPENAI_API_KEY: "fake-openai",
	GOOGLE_API_KEY: "fake-google",
	LEMON_FOX_API_KEY: "fake-lemonfox",
	FAL_API_KEY: "fake-fal",
	INWORLD_API_KEY: "fake-inworld",
	INWORLD_VOICE_ID: "voice-inworld",
	INWORLD_MODEL: "model-inworld",
	ELEVENLABS_API_KEY: "fake-eleven",
	ELEVENLABS_VOICE_ID: "voice-eleven",
	ELEVENLABS_MODEL: "model-eleven",
	OPENAI_STT_MODEL: "stt-model",
	OPENAI_TTS_MODEL: "tts-model",
	OPENAI_TTS_VOICE: "coral",
	FAL_VOICE: "Sarah",
};
const saved = new Map<string, string | undefined>();
const files = new Set<string>();
const requests: Request[] = [];
let inputDir = "";
let audio = "";
let tutor: ReturnType<typeof spyOn<typeof modes, "isTutorActive">>;
beforeEach(async () => {
	for (const [key, value] of Object.entries(settings)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	tutor = spyOn(modes, "isTutorActive").mockReturnValue(false);
	inputDir = await mkdtemp(join(tmpdir(), "mgs-speech-"));
	audio = join(inputDir, "source.ogg");
	await Bun.write(audio, "audio bytes");
	requests.length = 0;
	globalThis.fetch = (async () => {
		throw new Error("Unexpected network call in speech test");
	}) as unknown as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	tutor.mockRestore();
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	await Promise.all([...files].map((path) => rm(path, { force: true })));
	files.clear();
	await rm(inputDir, { recursive: true, force: true });
});
function intercept(reply: (request: Request) => Response | Promise<Response>) {
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		if (String(input) === "data:,") return new Response("");
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		requests.push(request);
		return reply(request);
	}) as unknown as typeof fetch;
}
async function savedAudio(path: string) {
	files.add(path);
	expect(await Bun.file(path).text()).toBe("mp3 bytes");
}

for (const Provider of [
	FalSttProvider,
	LemonFoxSttProvider,
	OpenAISttProvider,
]) {
	test(`${Provider.name} preserves original language and transmits audio`, async () => {
		intercept(() => Response.json({ text: " Hola mundo " }));
		expect(await new Provider().transcribe(audio, "audio/ogg")).toBe(
			"Hola mundo",
		);
		const request = requests[0];
		if (!request) throw new Error("No STT request");
		if (Provider === FalSttProvider) {
			expect(request.headers.get("authorization")).toBe("Key fake-fal");
			expect(await request.json()).toMatchObject({
				audio_url: `data:audio/ogg;base64,${Buffer.from("audio bytes").toString("base64")}`,
				diarize: false,
				tag_audio_events: false,
			});
		} else {
			const form = await request.formData();
			const file = form.get("file");
			expect(file).toBeInstanceOf(File);
			expect(await (file as File).text()).toBe("audio bytes");
			expect(form.get("language")).toBeNull();
			if (Provider === OpenAISttProvider)
				expect(form.get("model")).toBe("stt-model");
		}
	});
	test(`${Provider.name} sets English only for tutor mode`, async () => {
		tutor.mockReturnValue(true);
		intercept(() => Response.json({ text: "Hello" }));
		await new Provider().transcribe(audio, "audio/ogg");
		const request = requests[0];
		if (!request) throw new Error("No STT request");
		if (Provider === FalSttProvider)
			expect(
				((await request.json()) as { language_code?: string }).language_code,
			).toBe("eng");
		else expect((await request.formData()).get("language")).toBe("en");
	});
	test(`${Provider.name} exposes rejected transcription requests`, async () => {
		intercept(() => Response.json({ error: "invalid audio" }, { status: 400 }));
		await expect(
			new Provider().transcribe(audio, "audio/ogg"),
		).rejects.toThrow();
		expect(requests).toHaveLength(1);
	});
}
for (const Provider of [FalSttProvider, LemonFoxSttProvider]) {
	test(`${Provider.name} rejects empty transcripts`, async () => {
		intercept(() => Response.json({ text: " " }));
		await expect(new Provider().transcribe(audio, "audio/ogg")).rejects.toThrow(
			"empty text",
		);
	});
}

const upload = mock(async (_params: unknown) => ({
	name: "files/audio",
	uri: "https://google.test/audio",
	mimeType: "audio/ogg",
	state: "ACTIVE",
}));
const get = mock(async () => ({ state: "ACTIVE" }));
const remove = mock(async (_params: unknown) => ({}));
const generate = mock(async () => ({ text: "Transcript" }));
function gemini() {
	upload.mockReset();
	get.mockReset();
	remove.mockReset();
	generate.mockReset();
	upload.mockResolvedValue({
		name: "files/audio",
		uri: "https://google.test/audio",
		mimeType: "audio/ogg",
		state: "ACTIVE",
	});
	get.mockResolvedValue({ state: "ACTIVE" });
	remove.mockResolvedValue({});
	generate.mockResolvedValue({ text: "Transcript" });
	return new GeminiSttProvider({
		files: { upload, get, delete: remove },
		models: { generateContent: generate },
	} as unknown as GoogleGenAI);
}
test("Gemini STT uploads, transcribes original-language audio and deletes the remote file", async () => {
	const provider = gemini();
	expect(await provider.transcribe(audio, "audio/ogg")).toBe("Transcript");
	expect(upload.mock.calls[0]?.[0]).toMatchObject({
		file: audio,
		config: { mimeType: "audio/ogg" },
	});
	expect(JSON.stringify(generate.mock.calls)).toContain("Do NOT translate");
	expect(remove.mock.calls[0]?.[0]).toEqual({ name: "files/audio" });
});
test("Gemini STT polls processing files and uses tutor instructions", async () => {
	const provider = gemini();
	upload.mockResolvedValue({
		name: "files/audio",
		uri: "https://google.test/audio",
		mimeType: "audio/ogg",
		state: "PROCESSING",
	});
	tutor.mockReturnValue(true);
	await provider.transcribe(audio, "audio/ogg");
	expect(get).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(generate.mock.calls)).toContain("practicing English");
	expect(remove).toHaveBeenCalledTimes(1);
});
test("Gemini STT failed uploads never reach generation and still delete the file", async () => {
	const provider = gemini();
	upload.mockResolvedValue({
		name: "files/audio",
		uri: "https://google.test/audio",
		mimeType: "audio/ogg",
		state: "FAILED",
	});
	await expect(provider.transcribe(audio, "audio/ogg")).rejects.toThrow(
		"state=FAILED",
	);
	expect(generate).not.toHaveBeenCalled();
	expect(remove).toHaveBeenCalledTimes(1);
});
test("Gemini polling stops promptly when the operation is cancelled", async () => {
	const provider = gemini();
	upload.mockResolvedValue({
		name: "files/audio",
		uri: "https://google.test/audio",
		mimeType: "audio/ogg",
		state: "PROCESSING",
	});
	await expect(
		withDeadline("transcription", 50, () =>
			provider.transcribe(audio, "audio/ogg"),
		),
	).rejects.toThrow("timed out");
	expect(get).not.toHaveBeenCalled();
	expect(generate).not.toHaveBeenCalled();
});

for (const Provider of [
	OpenAITtsProvider,
	LemonFoxTtsProvider,
	InworldTtsProvider,
	ElevenLabsTtsProvider,
	FalTtsProvider,
]) {
	test(`${Provider.name} sends the selected voice and writes returned audio`, async () => {
		intercept((request) =>
			request.url.startsWith("https://fal.run/")
				? Response.json({ audio: { url: "https://audio.test/fal.mp3" } })
				: request.url.startsWith("https://api.inworld.ai/")
					? Response.json({
							audioContent: Buffer.from("mp3 bytes").toString("base64"),
							usage: { processedCharactersCount: 5 },
						})
					: new Response("mp3 bytes", {
							headers: { "content-type": "audio/mpeg" },
						}),
		);
		await savedAudio(await new Provider().synthesize("Hello"));
		const body = await requests[0]?.json();
		if (Provider === OpenAITtsProvider)
			expect(body).toMatchObject({
				model: "tts-model",
				voice: "coral",
				input: "Hello",
				response_format: "mp3",
			});
		if (Provider === LemonFoxTtsProvider)
			expect(body).toMatchObject({
				input: "Hello",
				voice: "heart",
				response_format: "mp3",
			});
		if (Provider === InworldTtsProvider)
			expect(body).toMatchObject({
				text: "Hello",
				voiceId: "voice-inworld",
				modelId: "model-inworld",
				audioConfig: { audioEncoding: "MP3" },
			});
		if (Provider === ElevenLabsTtsProvider) {
			expect(requests[0]?.url).toContain("voice-eleven");
			expect(body).toMatchObject({ text: "Hello", model_id: "model-eleven" });
			expect(requests[0]?.headers.get("xi-api-key")).toBe("fake-eleven");
		}
		if (Provider === FalTtsProvider) {
			expect(body).toMatchObject({ text: "Hello", voice: "Sarah" });
			expect(requests[1]?.url).toBe("https://audio.test/fal.mp3");
		}
	});
	test(`${Provider.name} propagates service failure without saving error bytes`, async () => {
		intercept(() => Response.json({ error: "invalid input" }, { status: 400 }));
		await expect(new Provider().synthesize("Hello")).rejects.toThrow();
		expect(requests).toHaveLength(1);
	});
	test(`${Provider.name} concurrent replies get distinct files even in the same millisecond`, async () => {
		intercept((request) =>
			request.url.startsWith("https://fal.run/")
				? Response.json({ audio: { url: "https://audio.test/fal.mp3" } })
				: request.url.startsWith("https://api.inworld.ai/")
					? Response.json({
							audioContent: Buffer.from("mp3 bytes").toString("base64"),
						})
					: new Response("mp3 bytes"),
		);
		const clock = spyOn(Date, "now").mockReturnValue(123456789);
		try {
			const provider = new Provider();
			const paths = await Promise.all([
				provider.synthesize("First"),
				provider.synthesize("Second"),
			]);
			paths.forEach((path) => {
				files.add(path);
			});
			expect(paths[0]).not.toBe(paths[1]);
		} finally {
			clock.mockRestore();
		}
	});
}
test("fal TTS rejects a missing audio URL and a failed download", async () => {
	intercept(() => Response.json({}));
	await expect(new FalTtsProvider().synthesize("Hello")).rejects.toThrow(
		"no audio URL",
	);
	intercept((request) =>
		request.url.startsWith("https://fal.run/")
			? Response.json({ audio: { url: "https://audio.test/file" } })
			: new Response("bad", { status: 503 }),
	);
	await expect(new FalTtsProvider().synthesize("Hello")).rejects.toThrow("503");
});
for (const [Provider, key] of [
	[LemonFoxSttProvider, "LEMON_FOX_API_KEY"],
	[FalSttProvider, "FAL_API_KEY"],
	[LemonFoxTtsProvider, "LEMON_FOX_API_KEY"],
	[FalTtsProvider, "FAL_API_KEY"],
	[InworldTtsProvider, "INWORLD_API_KEY"],
	[ElevenLabsTtsProvider, "ELEVENLABS_API_KEY"],
] as const) {
	test(`${Provider.name} reports missing credentials`, () => {
		delete process.env[key];
		expect(() => new Provider()).toThrow(key);
	});
}

test("voice send failure falls back to complete text and removes generated audio", async () => {
	intercept(() => new Response("mp3 bytes"));
	const { ctx, spies } = makeMockContext();
	let path = "";
	ctx.replyWithVoice = async () => {
		throw new Error("Telegram rejected voice");
	};
	const result = await sendResponse(
		{
			ctx,
			responseText: "Note [TTS]Hello[/TTS]",
			shouldGenImage: false,
			allowPhotoRequest: false,
			isGroup: false,
			buffer: {
				chatId: 899001,
				messages: [],
				lastActivity: Date.now(),
				messageCountSincePromotion: 0,
			},
		},
		{
			...defaultResponseDependencies,
			textToSpeech: async (text) => {
				path = await new OpenAITtsProvider().synthesize(text);
				return path;
			},
		},
	);
	expect(result?.sent).toBe(true);
	expect(spies.replies.map((r) => r.text)).toEqual(["Note Hello"]);
	expect(await Bun.file(path).exists()).toBe(false);
});
test("speech generation failure still delivers the text once", async () => {
	intercept(() => Response.json({ error: "unavailable" }, { status: 400 }));
	const { ctx, spies } = makeMockContext();
	let voices = 0;
	ctx.replyWithVoice = async () => {
		voices++;
		return {} as never;
	};
	const result = await sendResponse(
		{
			ctx,
			responseText: "[TTS]Hello[/TTS]",
			shouldGenImage: false,
			allowPhotoRequest: false,
			isGroup: false,
			buffer: {
				chatId: 899002,
				messages: [],
				lastActivity: Date.now(),
				messageCountSincePromotion: 0,
			},
		},
		{
			...defaultResponseDependencies,
			textToSpeech: (text) => new OpenAITtsProvider().synthesize(text),
		},
	);
	expect(result?.sent).toBe(true);
	expect(voices).toBe(0);
	expect(spies.replies.map((r) => r.text)).toEqual(["Hello"]);
});

test("ElevenLabs requests receive operation cancellation instead of running after a timeout", async () => {
	let cancelled = false;
	let release: (response: Response) => void = () => {};
	let work: Promise<string> | undefined;
	globalThis.fetch = (async (
		_input: string | URL | Request,
		init?: RequestInit,
	) =>
		new Promise<Response>((resolve, reject) => {
			release = resolve;
			const signal = init?.signal;
			signal?.addEventListener(
				"abort",
				() => {
					cancelled = true;
					reject(signal.reason);
				},
				{ once: true },
			);
		})) as unknown as typeof fetch;
	const provider = new ElevenLabsTtsProvider();
	try {
		await expect(
			withDeadline("speech", 50, () => {
				work = provider.synthesize("Hello");
				return work;
			}),
		).rejects.toThrow("timed out");
		expect(cancelled).toBe(true);
	} finally {
		release(new Response("mp3 bytes"));
		const path = await work?.catch(() => undefined);
		if (path) files.add(path);
	}
});

test("Gemini STT cleans up after generation failure", async () => {
	const provider = gemini();
	generate.mockRejectedValue(new Error("400 invalid request"));
	await expect(provider.transcribe(audio, "audio/ogg")).rejects.toThrow("400");
	expect(remove).toHaveBeenCalledTimes(1);
});
test("Gemini cleanup failure does not replace a successful transcript", async () => {
	const provider = gemini();
	remove.mockRejectedValue(new Error("delete unavailable"));
	expect(await provider.transcribe(audio, "audio/ogg")).toBe("Transcript");
});
test("Gemini upload failure cannot start generation or delete an unknown file", async () => {
	const provider = gemini();
	upload.mockRejectedValue(new Error("upload unavailable"));
	await expect(provider.transcribe(audio, "audio/ogg")).rejects.toThrow(
		"upload unavailable",
	);
	expect(generate).not.toHaveBeenCalled();
	expect(remove).not.toHaveBeenCalled();
});
