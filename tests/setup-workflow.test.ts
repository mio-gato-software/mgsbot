import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as core from "../src/ai/core.ts";
import { type BotConfig, loadConfig, saveConfig } from "../src/config.ts";
import { loadSensory } from "../src/memory/sensory.ts";
import {
	abortable,
	currentOperationSignal,
	withDeadline,
} from "../src/operation-deadline.ts";
import { processSetupConversation } from "../src/setup.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

let originalConfig: BotConfig;
let chatId = 880_000;
let generate: ReturnType<typeof spyOn<typeof core, "generateResponse">>;
const profile = {
	botName: "Mia",
	birthYear: 1995,
	gender: "female",
	personality: "Friendly",
};
beforeEach(() => {
	originalConfig = { ...loadConfig() };
	saveConfig({ isConfigured: false, botName: "MGS Bot", language: "en" });
	generate = spyOn(core, "generateResponse");
	chatId++;
});
afterEach(() => {
	generate.mockRestore();
	saveConfig(originalConfig);
});
function context() {
	return makeMockContext({ chatId, from: { id: 12345, first_name: "Ana" } });
}

test("setup retains conversation history until all profile fields are supplied", async () => {
	const { ctx, spies } = context();
	generate
		.mockResolvedValueOnce("What name should I use?")
		.mockResolvedValueOnce("What personality should I have?");
	await processSetupConversation(ctx, "Hello", "Ana");
	await processSetupConversation(ctx, "Mia", "Ana");
	expect(loadConfig().isConfigured).toBe(false);
	expect(spies.replies.map((r) => r.text)).toEqual([
		"What name should I use?",
		"What personality should I have?",
	]);
	expect(generate.mock.calls[1]?.[1].map((m) => m.content).join(" ")).toContain(
		"What name should I use?",
	);
	expect((await loadSensory(chatId)).messages).toHaveLength(4);
	expect(generate.mock.calls[0]?.[0]).toContain("initial setup assistant");
});
for (const lang of ["es", "en"] as const) {
	test(`${lang} setup saves normalized profile, hides JSON, and clears setup history`, async () => {
		saveConfig({ isConfigured: false, botName: "MGS Bot", language: lang });
		const { ctx, spies } = context();
		const raw = {
			...profile,
			botName: " Mia ",
			gender: lang === "es" ? " MUJER " : " FEMALE ",
			personality: " Friendly ",
		};
		generate.mockResolvedValue(
			`Ready!\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``,
		);
		await processSetupConversation(ctx, "My profile", "Ana");
		expect(loadConfig()).toMatchObject({
			isConfigured: true,
			botName: "Mia",
			birthYear: 1995,
			gender: lang === "es" ? "mujer" : "female",
			personality: "Friendly",
			language: lang,
		});
		expect(spies.replies[0]?.text).toBe("Ready!");
		expect(spies.replies[1]?.text).toContain("Mia");
		expect(spies.replies.map((r) => r.text).join(" ")).not.toContain(
			'"botName"',
		);
		expect((await loadSensory(chatId)).messages).toHaveLength(0);
	});
}
for (const change of [
	{ botName: 42 },
	{ botName: " " },
	{ birthYear: "not a year" },
	{ birthYear: 1995.5 },
	{ birthYear: null },
	{ birthYear: 0 },
	{ birthYear: -1 },
	{ birthYear: new Date().getFullYear() + 1 },
	{ gender: 42 },
	{ gender: "other" },
	{ personality: [] },
	{ personality: " " },
]) {
	test(`invalid setup profile stays unconfigured: ${JSON.stringify(change)}`, async () => {
		const { ctx, spies } = context();
		generate.mockResolvedValue(JSON.stringify({ ...profile, ...change }));
		await processSetupConversation(ctx, "Finish setup", "Ana");
		expect(loadConfig()).toMatchObject({
			isConfigured: false,
			botName: "MGS Bot",
		});
		expect(spies.replies.map((r) => r.text).join(" ")).not.toContain(
			"Setup complete",
		);
		expect((await loadSensory(chatId)).messages).toHaveLength(2);
	});
}
test("invalid gender gives a localized correction", async () => {
	saveConfig({ isConfigured: false, botName: "MGS Bot", language: "es" });
	const { ctx, spies } = context();
	generate.mockResolvedValue(JSON.stringify({ ...profile, gender: "other" }));
	await processSetupConversation(ctx, "Finish setup", "Ana");
	expect(spies.replies[0]?.text).toContain("hombre");
	expect(spies.replies[0]?.text).toContain("mujer");
});
test("malformed setup JSON falls back to conversation without saving a profile", async () => {
	const { ctx, spies } = context();
	const raw = '{ "botName": "Mia", "personality": }';
	generate.mockResolvedValue(raw);
	await processSetupConversation(ctx, "Finish setup", "Ana");
	expect(spies.replies[0]?.text).toBe(raw);
	expect(loadConfig().isConfigured).toBe(false);
});
test("empty model output keeps only the owner's turn and sends nothing", async () => {
	const { ctx, spies } = context();
	generate.mockResolvedValue(" ");
	await processSetupConversation(ctx, "Hello", "Ana");
	expect(spies.replies).toHaveLength(0);
	expect((await loadSensory(chatId)).messages).toHaveLength(1);
});
test("interrupted setup retains the owner's turn and cannot complete later", async () => {
	const { ctx, spies } = context();
	let release: (value: string) => void = () => {};
	generate.mockImplementation(() =>
		abortable(
			new Promise<string>((resolve) => {
				release = resolve;
			}),
			currentOperationSignal(),
		),
	);
	await expect(
		withDeadline("setup", 50, () =>
			processSetupConversation(ctx, "My profile", "Ana"),
		),
	).rejects.toThrow("timed out");
	release(JSON.stringify(profile));
	await Promise.resolve();
	expect(loadConfig().isConfigured).toBe(false);
	expect(spies.replies).toHaveLength(0);
	expect((await loadSensory(chatId)).messages).toHaveLength(1);
});
test("a provider error preserves the pending setup", async () => {
	const { ctx } = context();
	generate.mockRejectedValue(new Error("provider unavailable"));
	await expect(processSetupConversation(ctx, "Hello", "Ana")).rejects.toThrow(
		"provider unavailable",
	);
	expect(loadConfig().isConfigured).toBe(false);
	expect((await loadSensory(chatId)).messages).toHaveLength(1);
});
test("non-message setup requests are ignored", async () => {
	const { ctx } = context();
	Object.defineProperty(ctx, "chat", { value: undefined });
	await processSetupConversation(ctx, "Hello", "Ana");
	expect(generate).not.toHaveBeenCalled();
});

test("setup Markdown failures retry as plain text", async () => {
	const { ctx, spies } = context();
	generate.mockResolvedValue("*unfinished");
	const reply = ctx.reply.bind(ctx);
	let attempts = 0;
	ctx.reply = async (text, options) => {
		attempts++;
		if (attempts === 1) throw new Error("Bad Request: can't parse entities");
		return reply(text, options);
	};
	await processSetupConversation(ctx, "Hello", "Ana");
	expect(attempts).toBe(2);
	expect(spies.replies[0]?.options?.parse_mode).toBeUndefined();
});
test("setup transport failure is propagated without retrying the same reply", async () => {
	const { ctx } = context();
	generate.mockResolvedValue("What should my name be?");
	let attempts = 0;
	ctx.reply = async () => {
		attempts++;
		throw new Error("connection reset");
	};
	await expect(processSetupConversation(ctx, "Hello", "Ana")).rejects.toThrow(
		"connection reset",
	);
	expect(attempts).toBe(1);
	expect(loadConfig().isConfigured).toBe(false);
});
test("setup confirmation failure cannot cause a raw JSON reply", async () => {
	const { ctx } = context();
	generate.mockResolvedValue(JSON.stringify(profile));
	const replies: string[] = [];
	ctx.reply = async (text) => {
		replies.push(text);
		throw new Error("connection reset");
	};
	await expect(
		processSetupConversation(ctx, "My profile", "Ana"),
	).rejects.toThrow("connection reset");
	expect(replies).toHaveLength(1);
	expect(replies[0]).not.toContain('"botName"');
});
