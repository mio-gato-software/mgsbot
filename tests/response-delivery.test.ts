import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResponse } from "../src/response-plan.ts";
import {
	defaultResponseDependencies,
	type SendResponseOptions,
	sendResponse,
} from "../src/response-processor.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

function options(text: string): SendResponseOptions {
	return {
		ctx: makeMockContext().ctx,
		responseText: text,
		shouldGenImage: false,
		allowPhotoRequest: false,
		isGroup: false,
		buffer: {
			chatId: 820001,
			messages: [],
			lastActivity: Date.now(),
			messageCountSincePromotion: 0,
		},
	};
}
test("combined markers produce a delivery plan without exposing markers", () => {
	const plan = parseResponse(
		"[QUOTE_REPLY][REACT:🔥][IMAGE:cat] Mira [TTS]hola[/TTS]",
		{ allowImages: true, allowSpeech: true },
	);
	expect(plan).toEqual({
		quoteReplyRequested: true,
		reaction: "🔥",
		image: { prompt: "cat", self: false },
		text: "Mira hola",
		textOutsideSpeech: "Mira",
		speech: "hola",
	});
});
test("formatting errors fall back to plain text, transport errors do not", async () => {
	const input = options("*malformed");
	let calls = 0;
	input.ctx.reply = async () => {
		calls++;
		if (calls === 1) throw new Error("Bad Request: can't parse entities");
		return {} as never;
	};
	expect((await sendResponse(input))?.sent).toBe(true);
	expect(calls).toBe(2);
});
test("long replies split into valid-sized parts without losing text", async () => {
	const text = `${"x".repeat(3999)}🙂${"y".repeat(4100)}`;
	const { ctx, spies } = makeMockContext();
	await sendResponse({ ...options(text), ctx });
	expect(spies.replies.map((reply) => reply.text).join("")).toBe(text);
	expect(spies.replies.every((reply) => reply.text.length <= 4000)).toBe(true);
});
test("speech plus surrounding text delivers both and removes its temporary file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mgs-voice-test-"));
	const file = join(dir, "voice.ogg");
	try {
		await writeFile(file, "fake audio");
		const { ctx, spies } = makeMockContext();
		let voices = 0;
		ctx.replyWithVoice = async () => {
			voices++;
			return {} as never;
		};
		const result = await sendResponse(
			{ ...options("Nota [TTS]hola[/TTS]"), ctx },
			{ ...defaultResponseDependencies, textToSpeech: async () => file },
		);
		expect(voices).toBe(1);
		expect(spies.replies.map((reply) => reply.text)).toEqual(["Nota"]);
		expect(result?.cleanedText).toBe("Nota hola");
		await expect(stat(file)).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("failed voice delivery cleans up its file and propagates a failed fallback", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mgs-voice-test-"));
	const file = join(dir, "voice.ogg");
	try {
		await writeFile(file, "audio");
		const input = options("[TTS]hola[/TTS]");
		input.ctx.replyWithVoice = async () => {
			throw new Error("voice failed");
		};
		input.ctx.reply = async () => {
			throw new Error("text failed");
		};
		await expect(
			sendResponse(input, {
				...defaultResponseDependencies,
				textToSpeech: async () => file,
			}),
		).rejects.toThrow("text failed");
		await expect(stat(file)).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("an image-only reply counts as delivery and carries a memory description", async () => {
	const input = { ...options("[IMAGE: a cat]"), userImagePath: "fixture.png" };
	let photos = 0;
	input.ctx.replyWithPhoto = async () => {
		photos++;
		return {} as never;
	};
	const result = await sendResponse(input, {
		...defaultResponseDependencies,
		editImage: async () => Buffer.from("fake image"),
	});
	expect(photos).toBe(1);
	expect(result?.sent).toBe(true);
	expect(result?.cleanedText).toContain("a cat");
});
