import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Bot, Context } from "grammy";
import * as classifiers from "../src/ai/classifiers.ts";
import * as vision from "../src/ai/vision.ts";
import { backgroundTasks } from "../src/background-tasks.ts";
import * as state from "../src/bot-state.ts";
import { type BotConfig, loadConfig, saveConfig } from "../src/config.ts";
import * as conversation from "../src/conversation.ts";
import * as weather from "../src/daily-weather.ts";
import {
	openGroupContinuationWindow,
	resetGroupState,
} from "../src/group-state.ts";
import { handlePhoto } from "../src/handlers/photo.ts";
import { registerVoiceHandlers } from "../src/handlers/voice.ts";
import { loadSensory, saveSensory } from "../src/memory/sensory.ts";
import { OperationTimeoutError } from "../src/operation-deadline.ts";
import * as providers from "../src/providers/index.ts";
import type { ChatMessage } from "../src/providers/types.ts";
import * as stt from "../src/stt/index.ts";
import * as tts from "../src/tts/index.ts";
import {
	type MockContextOptions,
	makeMockContext,
} from "./helpers/telegram-mock.ts";

const originalFetch = globalThis.fetch;
const originalDependencies = {
	...conversation.defaultConversationDependencies,
};
const restores: Array<() => void> = [];
const audioPaths: string[] = [];
const generate = mock(
	async (_system: string, _messages: ChatMessage[]) => "Received",
);
let originalConfig: BotConfig;
let nextChat = 870_000;
let transcript = "This is my question";
let downloads = 0;
let classify: ReturnType<
	typeof spyOn<typeof classifiers, "classifyGroupMessageIntent">
>;
let social: ReturnType<
	typeof spyOn<typeof classifiers, "classifyGroupSocialIntent">
>;
let describe: ReturnType<typeof spyOn<typeof vision, "describeImage">>;
let transcribe: ReturnType<typeof spyOn<typeof stt, "transcribeAudio">>;
let imageProvider: ReturnType<
	typeof spyOn<typeof providers, "createChatProvider">
>;
let edit: ReturnType<typeof spyOn<typeof classifiers, "classifyEditIntent">>;

beforeEach(() => {
	originalConfig = { ...loadConfig() };
	saveConfig({
		isConfigured: true,
		botName: "Mia",
		birthYear: 1995,
		gender: "mujer",
		personality: "Friendly",
		language: "en",
	});
	resetGroupState();
	generate.mockClear();
	transcript = "This is my question";
	downloads = 0;
	audioPaths.length = 0;
	classify = spyOn(classifiers, "classifyGroupMessageIntent").mockResolvedValue(
		"silence",
	);
	social = spyOn(classifiers, "classifyGroupSocialIntent").mockResolvedValue({
		addressing: "about_bot",
		action: "silence",
		confidence: 1,
	});
	describe = spyOn(vision, "describeImage").mockResolvedValue("A blue chart");
	transcribe = spyOn(stt, "transcribeAudio").mockImplementation(
		async (path) => {
			expect(existsSync(path)).toBe(true);
			audioPaths.push(path);
			return transcript;
		},
	);
	imageProvider = spyOn(providers, "createChatProvider").mockReturnValue({
		name: "deepseek",
		model: "test",
		generateResponse: generate,
	});
	edit = spyOn(classifiers, "classifyEditIntent").mockResolvedValue(false);
	const weatherContext = spyOn(
		weather,
		"getCurrentWeatherContext",
	).mockResolvedValue(null);
	restores.push(() => weatherContext.mockRestore());
	const off = spyOn(state, "isBotOff").mockReturnValue(false);
	const sleeping = spyOn(state, "isSleepingHour").mockReturnValue(false);
	const speech = spyOn(tts, "isTtsAvailable").mockReturnValue(false);
	restores.push(
		() => classify.mockRestore(),
		() => social.mockRestore(),
		() => describe.mockRestore(),
		() => transcribe.mockRestore(),
		() => imageProvider.mockRestore(),
		() => edit.mockRestore(),
		() => off.mockRestore(),
		() => sleeping.mockRestore(),
		() => speech.mockRestore(),
	);
	Object.assign(conversation.defaultConversationDependencies, {
		generate,
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			relationship: null,
			relevantChapters: [],
		}),
	});
	globalThis.fetch = (async (input: string | URL | Request) => {
		expect(String(input)).toStartWith(
			"https://api.telegram.org/file/bottest-token/",
		);
		downloads++;
		return new Response("media bytes");
	}) as unknown as typeof fetch;
});
afterEach(async () => {
	await backgroundTasks.drain();
	for (const path of audioPaths) expect(existsSync(path)).toBe(false);
	restores.splice(0).forEach((restore) => {
		restore();
	});
	Object.assign(
		conversation.defaultConversationDependencies,
		originalDependencies,
	);
	globalThis.fetch = originalFetch;
	saveConfig(originalConfig);
	resetGroupState();
});
function context(options: MockContextOptions = {}) {
	const result = makeMockContext({
		chatId: options.chatType === "supergroup" ? -++nextChat : ++nextChat,
		from: { id: 987_654, first_name: "Ana" },
		...options,
	});
	Object.defineProperty(result.ctx, "api", {
		value: {
			getFile: async () => ({
				file_id: "media",
				file_unique_id: "media",
				file_path: "media/file.ogg",
			}),
		},
	});
	result.ctx.getFile = async () => result.ctx.api.getFile("media");
	return result;
}
function voiceHandler(kind: "voice" | "audio" = "voice") {
	const handlers = new Map<string, (ctx: Context) => Promise<void>>();
	registerVoiceHandlers(
		{
			on: (filter: string, handler: (ctx: Context) => Promise<void>) => {
				handlers.set(filter, handler);
			},
		} as unknown as Bot,
		"test-token",
	);
	const handler = handlers.get(`message:${kind}`);
	if (!handler) throw new Error("handler not registered");
	return handler;
}
async function messages(ctx: Context) {
	return (await loadSensory(ctx.chat?.id ?? 0)).messages;
}

test("DM voice downloads, transcribes, replies and saves the exchange", async () => {
	const { ctx, spies } = context({ voice: { file_id: "voice", duration: 20 } });
	await voiceHandler()(ctx);
	expect(downloads).toBe(1);
	expect(spies.replies.map((r) => r.text)).toEqual(["Received"]);
	expect(spies.chatActions.length).toBeGreaterThan(0);
	expect((await messages(ctx)).map((m) => [m.role, m.content])).toEqual([
		["user", "[Audio from Ana]: This is my question"],
		["model", "Received"],
	]);
});
test("direct group voice replies retain the referenced bot message", async () => {
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 500 },
		replyToMessage: {
			from: { id: 42, first_name: "Mia" },
			text: "What happened?",
		},
	});
	await voiceHandler()(ctx);
	expect(downloads).toBe(1);
	expect(spies.replies).toHaveLength(1);
	expect((await messages(ctx))[0]?.content).toContain(
		'Replying to Mia (bot): "What happened?"',
	);
	expect(classify).not.toHaveBeenCalled();
});
test("passive group voice is observed without visible typing or a reply", async () => {
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	await voiceHandler()(ctx);
	expect(spies.replies).toHaveLength(0);
	expect(spies.chatActions).toHaveLength(0);
	expect(generate).not.toHaveBeenCalled();
	expect((await messages(ctx))[0]?.content).toContain(
		"[Voice message from Ana]",
	);
});
test("oversized passive voice is recorded without a download", async () => {
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 121 },
	});
	await voiceHandler()(ctx);
	expect(downloads).toBe(0);
	expect(transcribe).not.toHaveBeenCalled();
	expect(spies.chatActions).toHaveLength(0);
	expect((await messages(ctx))[0]?.content).toContain(
		"exceeds the passive group limit",
	);
});
test("a name addressed in the transcript routes to a full response", async () => {
	transcript = "Mia, what do you think?";
	social.mockResolvedValue({
		addressing: "direct",
		action: "respond",
		confidence: 1,
	});
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	await voiceHandler()(ctx);
	expect(social.mock.calls[0]?.[0].currentMessage).toBe(transcript);
	expect(spies.replies).toHaveLength(1);
	expect((await messages(ctx)).filter((m) => m.role === "user")).toHaveLength(
		1,
	);
});
test("mentioning the bot in a transcript can remain an observation", async () => {
	transcript = "Mia is funny";
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	await voiceHandler()(ctx);
	expect(social).toHaveBeenCalledTimes(1);
	expect(generate).not.toHaveBeenCalled();
	expect(spies.replies).toHaveLength(0);
	expect(await messages(ctx)).toHaveLength(1);
});
test("voice continuation uses the last bot turn and records the user only once", async () => {
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	const buffer = await loadSensory(ctx.chat?.id ?? 0);
	buffer.messages = [
		{ role: "model", content: "Tell me more", timestamp: Date.now() - 1000 },
	];
	await saveSensory(buffer);
	openGroupContinuationWindow(buffer.chatId);
	classify.mockResolvedValue("respond");
	await voiceHandler()(ctx);
	expect(classify.mock.calls[0]?.[0].lastBotMessage).toBe("Tell me more");
	expect(spies.replies).toHaveLength(1);
	expect((await messages(ctx)).filter((m) => m.role === "user")).toHaveLength(
		1,
	);
});
test("voice replying to someone else never claims the bot continuation", async () => {
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
		replyToMessage: {
			from: { id: 999, first_name: "Luis" },
			text: "My question",
		},
	});
	openGroupContinuationWindow(ctx.chat?.id ?? 0);
	classify.mockResolvedValue("respond");
	await voiceHandler()(ctx);
	expect(classify).not.toHaveBeenCalled();
	expect(spies.replies).toHaveLength(0);
	expect((await messages(ctx))[0]?.content).toContain("Replying to Luis");
});
test("failed passive transcription is observed without invoking classifiers", async () => {
	transcript = "[transcription failed]";
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	await voiceHandler()(ctx);
	expect(classify).not.toHaveBeenCalled();
	expect(spies.replies).toHaveLength(0);
	expect((await messages(ctx))[0]?.content).toContain("transcription failed");
});
test("emoji-only passive transcription cannot trigger continuation", async () => {
	transcript = "🙂";
	const { ctx, spies } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	openGroupContinuationWindow(ctx.chat?.id ?? 0);
	await voiceHandler()(ctx);
	expect(classify).not.toHaveBeenCalled();
	expect(spies.replies).toHaveLength(0);
});
test("passive transcript memory is bounded while the classifier sees the full text", async () => {
	transcript = "a".repeat(1600);
	const { ctx } = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	openGroupContinuationWindow(ctx.chat?.id ?? 0);
	await voiceHandler()(ctx);
	expect((await messages(ctx))[0]?.content).toContain("[truncated]");
	expect((await messages(ctx))[0]?.content.length).toBeLessThan(1300);
	expect(classify.mock.calls[0]?.[0].currentMessage.length).toBe(1600);
});
test("addressed transcription timeouts propagate, passive timeouts stay invisible", async () => {
	transcribe.mockRejectedValue(new OperationTimeoutError("transcription"));
	const dm = context({ voice: { file_id: "voice", duration: 20 } });
	await expect(voiceHandler()(dm.ctx)).rejects.toBeInstanceOf(
		OperationTimeoutError,
	);
	expect(dm.spies.replies).toHaveLength(0);
	const group = context({
		chatType: "supergroup",
		voice: { file_id: "voice", duration: 20 },
	});
	await voiceHandler()(group.ctx);
	expect(group.spies.replies).toHaveLength(0);
});
test("audio files in groups remain passive unless addressed", async () => {
	const passive = context({
		chatType: "supergroup",
		audio: { file_id: "audio", mime_type: "audio/mpeg" },
	});
	await voiceHandler("audio")(passive.ctx);
	expect(downloads).toBe(0);
	expect((await messages(passive.ctx))[0]?.content).toBe(
		"[Audio file from Ana]",
	);
	const addressed = context({
		chatType: "supergroup",
		audio: { file_id: "audio", mime_type: "audio/mpeg" },
		replyToMessage: { from: { id: 42 }, text: "Send audio" },
	});
	await voiceHandler("audio")(addressed.ctx);
	expect(downloads).toBe(1);
	expect(addressed.spies.replies).toHaveLength(1);
	expect(transcribe.mock.calls[0]?.[1]).toBe("audio/mpeg");
});
test("audio download failures are recorded as a failed transcription", async () => {
	globalThis.fetch = (async () =>
		new Response("failed", { status: 404 })) as unknown as typeof fetch;
	const { ctx } = context({ audio: { file_id: "audio" } });
	await voiceHandler("audio")(ctx);
	expect(transcribe).not.toHaveBeenCalled();
	expect((await messages(ctx))[0]?.content).toContain("[transcription failed]");
});

function photo(options: MockContextOptions = {}) {
	return context({
		photo: [{ file_id: "photo", width: 100, height: 100 }],
		caption: "Read this chart",
		...options,
	});
}
test("non-inline photo analysis includes the question and cleans the image", async () => {
	const { ctx, spies } = photo();
	await handlePhoto(ctx, "test-token");
	expect(describe.mock.calls[0]?.slice(1)).toEqual([
		"image/jpeg",
		"Read this chart",
	]);
	expect(spies.replies).toHaveLength(1);
	expect((await messages(ctx))[0]?.content).toContain("A blue chart");
	expect(existsSync(describe.mock.calls[0]?.[0] ?? "")).toBe(false);
});
test("photo edit requests preserve raw evidence without redundant analysis", async () => {
	edit.mockResolvedValue(true);
	const { ctx, spies } = photo({ caption: "Make it brighter" });
	await handlePhoto(ctx, "test-token");
	expect(describe).not.toHaveBeenCalled();
	expect(generate).toHaveBeenCalledTimes(1);
	expect(spies.replies).toHaveLength(1);
});
test("failed photo analysis replies helpfully and removes the temporary file", async () => {
	describe.mockResolvedValue("[image description failed]");
	const { ctx, spies } = photo();
	await handlePhoto(ctx, "test-token");
	expect(generate).not.toHaveBeenCalled();
	expect(spies.replies[0]?.text).toContain("couldn't read that image");
	expect(existsSync(describe.mock.calls[0]?.[0] ?? "")).toBe(false);
});
test("passive group photos avoid downloads and preserve the caption", async () => {
	const { ctx, spies } = photo({ chatType: "supergroup" });
	await handlePhoto(ctx, "test-token");
	expect(downloads).toBe(0);
	expect(spies.replies).toHaveLength(0);
	expect(spies.chatActions).toHaveLength(0);
	expect((await messages(ctx))[0]?.content).toContain("Read this chart");
});
test("photo analysis timeout propagates after cleanup", async () => {
	describe.mockRejectedValue(new OperationTimeoutError("vision"));
	const { ctx, spies } = photo();
	await expect(handlePhoto(ctx, "test-token")).rejects.toBeInstanceOf(
		OperationTimeoutError,
	);
	expect(existsSync(describe.mock.calls[0]?.[0] ?? "")).toBe(false);
	expect(spies.replies).toHaveLength(0);
});
test("inline providers receive image bytes and skip separate analysis", async () => {
	imageProvider.mockReturnValue({
		name: "openai",
		model: "test",
		generateResponse: generate,
	});
	const { ctx } = photo();
	await handlePhoto(ctx, "test-token");
	expect(describe).not.toHaveBeenCalled();
	expect(generate).toHaveBeenCalledTimes(1);
	expect(generate.mock.calls[0]?.[1].at(-1)?.mediaAttachment).toEqual({
		data: Buffer.from("media bytes").toString("base64"),
		mimeType: "image/jpeg",
	});
	const prompt = (await messages(ctx))[0];
	expect(prompt?.content).toContain("Read this chart");
});
