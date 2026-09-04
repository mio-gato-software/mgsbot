import { afterEach, expect, test } from "bun:test";
import { backgroundTasks } from "../src/background-tasks.ts";
import {
	type ConversationDependencies,
	defaultConversationDependencies,
	processConversation,
} from "../src/conversation.ts";
import { loadSensory } from "../src/memory/sensory.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

let chatId = 810001;
function dependencies(): ConversationDependencies {
	return {
		...defaultConversationDependencies,
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "Test bot system prompt",
		generate: async () => "Hola, Ana",
	};
}
afterEach(() => backgroundTasks.drain());
test("a complete turn sends and persists the same reply", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	services.generate = async (system, messages) => {
		expect(system).toBe("Test bot system prompt");
		expect(messages.at(-1)?.content).toContain("hola");
		return "Hola, Ana";
	};
	expect(await processConversation(ctx, "hola", "Ana", {}, services)).toBe(
		true,
	);
	expect(spies.replies.map((reply) => reply.text)).toEqual(["Hola, Ana"]);
	expect(
		(await loadSensory(chatId)).messages.map((message) => message.role),
	).toEqual(["user", "model"]);
});
test("a Telegram delivery failure never records an unsent bot reply", async () => {
	const { ctx } = makeMockContext({ chatId: ++chatId });
	let attempts = 0;
	ctx.reply = async () => {
		attempts++;
		throw new Error("connection reset");
	};
	await expect(
		processConversation(ctx, "hola", "Ana", {}, dependencies()),
	).rejects.toThrow("connection reset");
	expect(attempts).toBe(1);
	expect(
		(await loadSensory(chatId)).messages.map((message) => message.role),
	).toEqual(["user"]);
});
test("full context retains group continuation flags", async () => {
	const { ctx } = makeMockContext({ chatType: "group", chatId: ++chatId });
	const services = dependencies();
	let assembled = false;
	services.assemble = async (context) => {
		assembled = true;
		expect(context.groupContinuation).toBe(true);
		expect(context.groupAutoReply).toBe(false);
		return "Group prompt";
	};
	await processConversation(
		ctx,
		"sí",
		"Ana",
		{ groupContinuation: true },
		services,
	);
	expect(assembled).toBe(true);
});
test("silence persists the user turn without inventing a bot response", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	services.generate = async () => "[SILENCE]";
	expect(await processConversation(ctx, "hola", "Ana", {}, services)).toBe(
		false,
	);
	expect(spies.replies).toHaveLength(0);
	expect((await loadSensory(chatId)).messages).toHaveLength(1);
});
test("historical-context bypass skips retrieval", async () => {
	const { ctx } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	services.retrieve = async () => {
		throw new Error("must not retrieve");
	};
	expect(
		await processConversation(
			ctx,
			"hola",
			"Ana",
			{ skipHistoricalContext: true },
			services,
		),
	).toBe(true);
});
