import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CartesiaTtsProvider } from "../src/tts/cartesia.ts";

test("Cartesia synthesizes MP3 audio with the configured voice", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "mgsbot-cartesia-"));
	const previousModel = process.env.CARTESIA_MODEL;
	const previousLanguage = process.env.CARTESIA_LANGUAGE;
	process.env.CARTESIA_MODEL = "   ";
	process.env.CARTESIA_LANGUAGE = "   ";
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const fetchImpl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		requestUrl = String(input);
		requestInit = init;
		return new Response(Uint8Array.from([0x49, 0x44, 0x33, 0x03]), {
			status: 200,
			headers: { "Content-Type": "audio/mpeg" },
		});
	};

	try {
		const provider = new CartesiaTtsProvider({
			apiKey: "sk-car-test",
			voiceId: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
			fetchImpl,
			outputDir,
			now: () => 1234,
		});

		const audioPath = await provider.synthesize("Hola, Eliaquín.");

		expect(requestUrl).toBe("https://api.cartesia.ai/tts/bytes");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			Authorization: "Bearer sk-car-test",
			"Cartesia-Version": "2026-08-14",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			model_id: "sonic-3.6",
			transcript: "Hola, Eliaquín.",
			voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
			output_format: {
				container: "mp3",
				sample_rate: 44100,
				bit_rate: 128000,
			},
		});
		expect(audioPath.startsWith(join(outputDir, "tts_cartesia_1234_"))).toBe(
			true,
		);
		expect(audioPath.endsWith(".mp3")).toBe(true);
		expect(await readFile(audioPath)).toEqual(
			Buffer.from([0x49, 0x44, 0x33, 0x03]),
		);
	} finally {
		if (previousModel === undefined) delete process.env.CARTESIA_MODEL;
		else process.env.CARTESIA_MODEL = previousModel;
		if (previousLanguage === undefined) delete process.env.CARTESIA_LANGUAGE;
		else process.env.CARTESIA_LANGUAGE = previousLanguage;
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("Cartesia reports API errors instead of saving an invalid audio file", async () => {
	const outputDir = await mkdtemp(join(tmpdir(), "mgsbot-cartesia-error-"));
	const fetchImpl = async (): Promise<Response> =>
		new Response("rate limit exceeded", {
			status: 429,
			statusText: "Too Many Requests",
		});

	try {
		const provider = new CartesiaTtsProvider({
			apiKey: "sk-car-test",
			voiceId: "voice-test",
			fetchImpl,
			outputDir,
		});

		await expect(provider.synthesize("Hola")).rejects.toThrow(
			"Cartesia TTS failed: 429 Too Many Requests rate limit exceeded",
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("concurrent Cartesia generations use distinct output files", async () => {
	const outputDir = await mkdtemp(
		join(tmpdir(), "mgsbot-cartesia-concurrent-"),
	);
	const fetchImpl = async (): Promise<Response> =>
		new Response(Uint8Array.from([0x49, 0x44, 0x33]), { status: 200 });

	try {
		const provider = new CartesiaTtsProvider({
			apiKey: "sk-car-test",
			voiceId: "voice-test",
			fetchImpl,
			outputDir,
			now: () => 1234,
		});

		const paths = await Promise.all([
			provider.synthesize("Primera"),
			provider.synthesize("Segunda"),
		]);

		expect(paths[0]).not.toBe(paths[1]);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("the TTS factory creates Cartesia when it is explicitly selected", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			'import { getTtsProviderName } from "./src/tts/index.ts"; process.stdout.write("RESULT=" + getTtsProviderName());',
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				TTS_PROVIDER: "cartesia",
				CARTESIA_API_KEY: "sk-car-test",
				CARTESIA_VOICE_ID: "voice-test",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	const exitCode = await child.exited;

	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toContain("RESULT=cartesia");
});
