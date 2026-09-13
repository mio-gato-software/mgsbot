import { afterEach, expect, test } from "bun:test";
import { backgroundTasks } from "../src/background-tasks.ts";
import {
	type ConversationDependencies,
	defaultConversationDependencies,
	observeConversationTurn,
	processConversation,
} from "../src/conversation.ts";
import { RECENT_IMAGE_MAX_AGE_MS } from "../src/image-context.ts";
import { loadSensory, saveSensory } from "../src/memory/sensory.ts";
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

test("a searched reply sends a notice first and keeps raw references out of sensory memory", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	let calls = 0;
	let refreshes = 0;
	services.web = {
		isEnabled: () => true,
		context: async () => "CACHED REFERENCE ONLY",
		refreshHeadlines: async () => {
			refreshes++;
		},
		search: async () => {
			expect(spies.replies.map((reply) => reply.text)).toEqual([
				"Déjame comprobarlo",
			]);
			return "RAW WEB REFERENCE ONLY https://example.com/story";
		},
	};
	services.generate = async (_system, messages) => {
		calls++;
		if (calls === 1)
			return '[WEB_SEARCH]{"query":"public news","notice":"Déjame comprobarlo"}[/WEB_SEARCH]';
		expect(messages.at(-1)?.content).toContain("RAW WEB REFERENCE ONLY");
		return "El reporte todavía no está confirmado: https://example.com/story";
	};
	expect(
		await processConversation(
			ctx,
			"¿Qué se sabe de esa noticia?",
			"Ana",
			{},
			services,
		),
	).toBe(true);
	expect(spies.replies).toHaveLength(2);
	const messages = (await loadSensory(chatId)).messages;
	expect(messages.map((message) => message.role)).toEqual(["user", "model"]);
	expect(JSON.stringify(messages)).not.toContain("REFERENCE ONLY");
	expect(JSON.stringify(messages)).not.toContain("WEB_SEARCH");
	expect(messages[1]?.content).toContain("no está confirmado");
	await backgroundTasks.drain();
	expect(refreshes).toBe(1);
});

test("a follow-up recovers the original image after disk reload and text-history truncation", async () => {
	const id = ++chatId;
	const services = dependencies();
	const photo = makeMockContext({
		chatId: id,
		photo: [{ file_id: "original", width: 100, height: 100 }],
	});
	await processConversation(
		photo.ctx,
		"[Image from Ana]",
		"Ana",
		{ mediaAttachment: { data: "pixels", mimeType: "image/jpeg" } },
		services,
	);
	const saved = await loadSensory(id);
	expect(saved.messages[0]?.image).toEqual({
		fileId: "original",
		messageId: 1,
	});
	expect(JSON.stringify(saved)).not.toContain("pixels");
	// Enough text to exclude the original image marker from the prompt budget.
	saved.messages.push({
		role: "model",
		content: "detail ".repeat(400),
		timestamp: Date.now(),
	});
	await saveSensory(saved);
	services.prepareImage = async (_ctx, reference, question) => {
		expect(reference.fileId).toBe("original");
		expect(question).toBe("¿Y qué dice el letrero?");
		return {
			filePath: "/tmp/mgsbot-test-nonexistent-photo",
			mediaAttachment: { data: "recovered-pixels", mimeType: "image/jpeg" },
		};
	};
	services.generate = async (_system, messages) => {
		expect(
			messages.some((message) => message.content.includes("[Image from Ana]")),
		).toBe(false);
		expect(messages.filter((message) => message.mediaAttachment)).toHaveLength(
			1,
		);
		expect(messages.at(-1)?.mediaAttachment?.data).toBe("recovered-pixels");
		return "Dice salida";
	};
	await processConversation(
		makeMockContext({ chatId: id }).ctx,
		"¿Y qué dice el letrero?",
		"Ana",
		{},
		services,
	);
	const updated = await loadSensory(id);
	expect(updated.messages.filter((message) => message.image)).toHaveLength(1);
});

test("passive group images are referenced without analysis and available when their sender asks", async () => {
	const id = ++chatId;
	const photo = makeMockContext({
		chatId: id,
		chatType: "group",
		photo: [{ file_id: "passive", width: 100, height: 100 }],
	});
	await observeConversationTurn(photo.ctx, "[Image from Ana]", "Ana");
	const services = dependencies();
	let prepared = false;
	services.prepareImage = async () => {
		prepared = true;
		return {
			filePath: "/tmp/mgsbot-test-nonexistent-photo",
			description: "The sign reads EXIT.",
		};
	};
	services.generate = async (_system, messages) => {
		expect(messages.at(-1)?.content).toContain("The sign reads EXIT.");
		return "Dice EXIT";
	};
	await processConversation(
		makeMockContext({ chatId: id, chatType: "group" }).ctx,
		"Mira el letrero",
		"Ana",
		{},
		services,
	);
	expect(prepared).toBe(true);
});

test("expired images and another chat do not trigger downloads", async () => {
	const id = ++chatId;
	await observeConversationTurn(
		makeMockContext({
			chatId: id,
			photo: [{ file_id: "old", width: 1, height: 1 }],
		}).ctx,
		"photo",
		"Ana",
	);
	const saved = await loadSensory(id);
	if (saved.messages[0])
		saved.messages[0].timestamp = Date.now() - RECENT_IMAGE_MAX_AGE_MS - 1;
	await saveSensory(saved);
	const services = dependencies();
	services.prepareImage = async () => {
		throw new Error("Unexpected image download");
	};
	let calls = 0;
	services.generate = async (_system, messages) => {
		calls++;
		expect(
			messages.every(
				(message) =>
					!message.mediaAttachment &&
					!message.content.includes("could not be retrieved"),
			),
		).toBe(true);
		return "Hola";
	};
	await processConversation(
		makeMockContext({ chatId: id }).ctx,
		"hola",
		"Ana",
		{},
		services,
	);
	await processConversation(
		makeMockContext({ chatId: ++chatId }).ctx,
		"hola",
		"Ana",
		{},
		services,
	);
	expect(calls).toBe(2);
});

test("a failed image recovery still answers with explicit missing-evidence context", async () => {
	const id = ++chatId;
	await observeConversationTurn(
		makeMockContext({
			chatId: id,
			photo: [{ file_id: "missing", width: 1, height: 1 }],
		}).ctx,
		"photo",
		"Ana",
	);
	const services = dependencies();
	services.prepareImage = async () => {
		throw new Error("Telegram unavailable");
	};
	services.generate = async (_system, messages) => {
		expect(messages.at(-1)?.content).toContain("Do not invent visual details");
		expect(messages.at(-1)?.mediaAttachment).toBeUndefined();
		return "No pude recuperar la imagen";
	};
	expect(
		await processConversation(
			makeMockContext({ chatId: id }).ctx,
			"¿Qué ves?",
			"Ana",
			{},
			services,
		),
	).toBe(true);
});
