import { afterEach, expect, spyOn, test } from "bun:test";
import { backgroundTasks } from "../src/background-tasks.ts";
import { ChatUpdateQueue } from "../src/chat-update-queue.ts";
import {
	type ConversationDependencies,
	defaultConversationDependencies,
	observeConversationTurn,
	processConversation,
} from "../src/conversation.ts";
import { RECENT_IMAGE_MAX_AGE_MS } from "../src/image-context.ts";
import {
	loadSemanticStore,
	saveSemanticStore,
} from "../src/memory/semantic.ts";
import { loadSensory, saveSensory } from "../src/memory/sensory.ts";
import { weatherCurrent } from "../src/prompt/sections/activity.ts";
import {
	defaultResponseDependencies,
	sendResponse,
} from "../src/response-processor.ts";
import type { SemanticFact } from "../src/types.ts";
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
		expect(system).toStartWith("Test bot system prompt");
		expect(system).toContain(
			"Do not promise to check an event or send something later.",
		);
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

test("a direct agenda reply skips conversational retrieval, assembly and generation", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	services.commitments = async (_request, _defaults, execution) => {
		execution?.reply("Recordatorio guardado");
		return "";
	};
	services.retrieve = async () => {
		throw new Error("unexpected retrieval");
	};
	services.assemble = async () => {
		throw new Error("unexpected prompt");
	};
	services.generate = async () => {
		throw new Error("unexpected generation");
	};

	expect(
		await processConversation(ctx, "Avísame mañana", "Ana", {}, services),
	).toBe(true);
	expect(spies.replies.map((reply) => reply.text)).toEqual([
		"Recordatorio guardado",
	]);
});

test("generation reinforces only the complete facts that survived filtering and budgeting", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	const retrieve = services.retrieve;
	const yesterday = Date.now() - 86_400_000;
	const visible: SemanticFact = {
		id: "shown",
		category: "person",
		subject: "Ana",
		content: "Ana hace cerámica",
		importance: 3,
		confidence: 0.35,
		embedding: [],
		createdAt: yesterday,
		lastConfirmed: yesterday,
	};
	const facts = [
		visible,
		{
			...visible,
			id: "other-person",
			subject: "Bea",
			content: "Bea estudia astronomía",
		},
		{ ...visible, id: "too-long", content: "Detalle ".repeat(240) },
	];
	const previous = await loadSemanticStore();
	await saveSemanticStore(facts);
	const weather = spyOn(weatherCurrent, "render").mockReturnValue(null);
	try {
		services.retrieve = async (input) => {
			expect(input.relevantOnly).toBe(true);
			return {
				...(await retrieve(input)),
				relevantFacts: facts,
				activeNames: ["Ana"],
			};
		};
		services.assemble = defaultConversationDependencies.assemble;
		services.generate = async (system) => {
			expect(system).toContain(visible.content);
			expect(system).not.toContain("Bea estudia");
			expect(system).not.toContain("Detalle");
			return "Me habías contado que haces cerámica.";
		};
		await processConversation(
			ctx,
			"¿Cuál era mi afición?",
			"Ana",
			{},
			services,
		);
		await backgroundTasks.drain();
		expect(spies.replies.map(({ text }) => text)).toEqual([
			"Me habías contado que haces cerámica.",
		]);
		const stored = await loadSemanticStore();
		expect(
			stored.filter((fact) => fact.lastRecalledAt).map((fact) => fact.id),
		).toEqual(["shown"]);
		expect(stored[0]?.lastConfirmed).toBe(yesterday);
	} finally {
		weather.mockRestore();
		await saveSemanticStore(previous);
	}
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

test("chained search and weather persist only the delivered answer, with a single notice", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	services.web = {
		isEnabled: () => true,
		context: async () => "",
		refreshHeadlines: async () => {},
		search: async () =>
			"RAW SCHEDULE: San Pedro de Macorís, DO, 20:00. https://example.com/schedule",
	};
	services.weather = {
		isEnabled: () => true,
		instructions: () => "Weather tool available",
		lookup: async (request) => {
			expect(request).toMatchObject({
				location: "San Pedro de Macorís",
				countryCode: "DO",
				hour: 20,
			});
			return "RAW FORECAST: rain probability 60% at 20:00. https://open-meteo.com/";
		},
	};
	let calls = 0;
	services.generate = async (_system, messages) => {
		calls++;
		if (calls === 1)
			return '[WEB_SEARCH]{"query":"horario y sede del juego","notice":"Voy a verificar."}[/WEB_SEARCH]';
		if (calls === 2) {
			expect(messages.at(-1)?.content).toContain("RAW SCHEDULE");
			return '[WEATHER_LOOKUP]{"location":"San Pedro de Macorís","countryCode":"DO","hour":20,"notice":"Reviso el clima."}[/WEATHER_LOOKUP]';
		}
		expect(messages.map((message) => message.content).join("\n")).toContain(
			"RAW SCHEDULE",
		);
		expect(messages.at(-1)?.content).toContain("RAW FORECAST");
		return "El juego es en San Pedro a las 20:00 y hay un 60% de probabilidad de lluvia a esa hora. https://example.com/schedule https://open-meteo.com/";
	};
	expect(
		await processConversation(
			ctx,
			"¿Lloverá para el juego?",
			"Ana",
			{},
			services,
		),
	).toBe(true);
	expect(calls).toBe(3);
	expect(spies.replies).toHaveLength(2);
	expect(spies.replies[0]?.text).toBe("Voy a verificar.");
	const messages = (await loadSensory(chatId)).messages;
	expect(messages.map((message) => message.role)).toEqual(["user", "model"]);
	expect(messages[1]?.content).toContain("60%");
	expect(JSON.stringify(messages)).not.toMatch(
		/RAW SCHEDULE|RAW FORECAST|WEB_SEARCH|WEATHER_LOOKUP|Voy a verificar/,
	);
});

test("weather replies persist the final answer and preserve the place through a follow-up", async () => {
	const { ctx, spies } = makeMockContext({ chatId: ++chatId });
	const services = dependencies();
	services.web = {
		isEnabled: () => false,
		context: async () => "",
		refreshHeadlines: async () => {},
		search: async () => {
			throw new Error("Unexpected search");
		},
	};
	const offsets: number[] = [];
	services.weather = {
		isEnabled: () => true,
		instructions: () => "Weather is available",
		lookup: async (request) => {
			expect(request.location).toBe("San Pedro de Macorís");
			offsets.push(request.dayOffset ?? 0);
			return "RAW WEATHER REFERENCE ONLY";
		},
	};
	let calls = 0;
	services.generate = async (_system, messages) => {
		calls++;
		if (calls % 2 === 1) {
			if (calls === 3)
				expect(JSON.stringify(messages)).toContain("En San Pedro");
			return `[WEATHER_LOOKUP]{"location":"San Pedro de Macorís","dayOffset":${calls === 1 ? 0 : 1},"period":"night","notice":"Déjame mirar."}[/WEATHER_LOOKUP]`;
		}
		expect(messages.at(-1)?.content).toContain("RAW WEATHER REFERENCE ONLY");
		return "En San Pedro hay probabilidad de lluvia esta noche.";
	};
	await processConversation(
		ctx,
		"¿Cómo estará esta noche en San Pedro de Macorís?",
		"Ana",
		{},
		services,
	);
	await processConversation(ctx, "¿Y mañana?", "Ana", {}, services);
	expect(offsets).toEqual([0, 1]);
	expect(spies.replies).toHaveLength(4);
	const saved = (await loadSensory(chatId)).messages;
	expect(saved.map((message) => message.role)).toEqual([
		"user",
		"model",
		"user",
		"model",
	]);
	expect(JSON.stringify(saved)).not.toContain("RAW WEATHER");
	expect(JSON.stringify(saved)).not.toContain("WEATHER_LOOKUP");
});

test("a follow-up recovers the original image after disk reload and text-history truncation", async () => {
	const id = ++chatId;
	const services = dependencies();
	const requests: string[] = [];
	services.commitments = async (input) => {
		expect(input.referenceImage?.size).toBe("720×1080 px (2:3)");
		requests.push(input.text);
		return "";
	};
	const photo = makeMockContext({
		chatId: id,
		photo: [{ file_id: "original", width: 720, height: 1080 }],
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
		dimensions: { width: 720, height: 1080 },
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
		expect(messages.at(-1)?.content).toContain("720×1080 px (2:3)");
		return "Dice salida";
	};
	await processConversation(
		makeMockContext({ chatId: id, text: "¿Y qué dice el letrero?" }).ctx,
		"¿Y qué dice el letrero?",
		"Ana",
		{},
		services,
	);
	expect(requests).toEqual(["", "¿Y qué dice el letrero?"]);
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

test("a provider deadline sends a retry notice without recording an invented answer", async () => {
	const { withDeadline } = await import("../src/operation-deadline.ts");
	for (const phase of ["retrieval", "generation"] as const) {
		const { ctx, spies } = makeMockContext({ chatId: ++chatId });
		const services = dependencies();
		const hang = () =>
			withDeadline(phase, 10, async () => new Promise<never>(() => {}));
		if (phase === "retrieval") services.retrieve = hang;
		else services.generate = hang;
		expect(await processConversation(ctx, "hola", "Ana", {}, services)).toBe(
			false,
		);
		expect(spies.replies).toHaveLength(1);
		expect(spies.replies[0]?.text).toMatch(/tardó demasiado|took too long/);
		expect((await loadSensory(chatId)).messages.map((m) => m.role)).toEqual([
			"user",
		]);
	}
});

test("a group retry passes the replied-to bot photo caption to task interpretation", async () => {
	const services = dependencies();
	services.prepareImage = async () => {
		throw new Error("Reference image is irrelevant to task execution");
	};
	let received = false;
	services.commitments = async (input) => {
		expect(input.text).toBe("Inténtalo otra vez");
		expect(input.replyContext).toEqual({
			messageId: 77,
			text: "El reporte falló durante la revisión.",
			isBot: true,
		});
		received = true;
		return "";
	};
	const { ctx } = makeMockContext({
		chatId: ++chatId,
		chatType: "supergroup",
		text: "Inténtalo otra vez",
		replyToMessage: {
			message_id: 77,
			from: { id: 42 },
			caption: "El reporte falló durante la revisión.",
			photo: [{ file_id: "report", width: 100, height: 100 }],
		},
	});
	await processConversation(ctx, "Inténtalo otra vez", "Ada", {}, services);
	expect(received).toBe(true);
});

test("group continuation routing interprets an authorized report retry and uses image-only delivery", async () => {
	const services = dependencies();
	const text = "Inténtalo de nuevo";
	const { ctx, spies } = makeMockContext({
		chatId: ++chatId,
		chatType: "supergroup",
		text,
	});
	let interpreted = false;
	services.commitments = async (input, _services, execution) => {
		expect(input.text).toBe(text);
		interpreted = true;
		if (!execution) throw Error("Missing execution");
		await execution.run({ id: "saved-report" } as never);
		return "";
	};
	services.scheduled = async () => ({
		text: "Yesterday results, standings, and today's fixtures",
		image: Buffer.from("report"),
		delivery: "image_only",
	});
	services.generate = async () => {
		throw Error("Retry bypassed saved report");
	};
	let photos = 0;
	ctx.replyWithPhoto = async (_photo, options) => {
		photos++;
		expect(options?.caption).toBeUndefined();
		return {} as never;
	};
	await processConversation(
		ctx,
		text,
		"Ada",
		{ groupContinuation: true },
		services,
	);
	expect(interpreted).toBe(true);
	expect(photos).toBe(1);
	expect(spies.replies).toHaveLength(0);
});

test("unthreaded bilingual retries recover the saved image-only report before a lookup or generic photo", async () => {
	for (const [i, text] of ["¿Lo mandas de nuevo?", "Demo. Again."].entries()) {
		const { ctx, spies } = makeMockContext({
			chatId: ++chatId,
			chatType: "supergroup",
			text,
		});
		const buf = await loadSensory(chatId);
		buf.allowPhotoRequest = true;
		buf.messages.push({
			role: "model",
			content: "Resultados de la jornada.",
			timestamp: Date.now() - 36 * 60000,
			reportTaskId: "saved-report",
		});
		await saveSensory(buf);
		const services = dependencies();
		const proposal =
			i === 0
				? '[WEB_SEARCH]{"query":"liga marcadores","notice":"Voy a revisar."}[/WEB_SEARCH]'
				: "Aquí está [IMAGE: square scoreboard]";
		services.generate = async () => proposal;
		services.web = {
			isEnabled: () => i === 0,
			context: async () => "",
			refreshHeadlines: async () => {},
			search: async () => {
				throw Error("ordinary search bypassed the saved report");
			},
		};
		services.commitments = async (request, _defaults, execution) => {
			expect(request.recentConversation?.at(-1)?.reportTaskId).toBe(
				"saved-report",
			);
			execution?.onReportReview?.(async (draft) => {
				expect(draft).toContain(
					i === 0 ? "liga marcadores" : "square scoreboard",
				);
				return () => execution.run({ id: "saved-report" } as never);
			});
			return "";
		};
		services.scheduled = async () => ({
			text: "Resultados y tabla verificados",
			image: Buffer.from("prepared portrait"),
			delivery: "image_only",
		});
		let photos = 0;
		ctx.replyWithPhoto = async (_photo, options) => {
			expect(options?.caption).toBeUndefined();
			photos++;
			return { message_id: 100 } as never;
		};
		expect(await processConversation(ctx, text, "Ada", {}, services)).toBe(
			true,
		);
		expect(photos).toBe(1);
		expect(spies.replies).toHaveLength(0);
		expect((await loadSensory(chatId)).messages.at(-1)).toMatchObject({
			content: "Resultados y tabla verificados",
			reportTaskId: "saved-report",
		});
	}
});

test("an independent lookup still announces and executes when report review is available", async () => {
	const text = "¿A qué hora abre el parque?";
	const { ctx, spies } = makeMockContext({
		chatId: ++chatId,
		chatType: "group",
		text,
	});
	const services = dependencies();
	let searched = false;
	let reviews = 0;
	services.web = {
		isEnabled: () => true,
		context: async () => "",
		refreshHeadlines: async () => {},
		search: async () => {
			expect(spies.replies.map((r) => r.text)).toEqual(["Voy a verificar."]);
			searched = true;
			return "Abre a las nueve.";
		},
	};
	services.generate = async () =>
		searched
			? "Abre a las nueve."
			: '[WEB_SEARCH]{"query":"horario parque","notice":"Voy a verificar."}[/WEB_SEARCH]';
	services.commitments = async (_r, _s, e) => {
		e?.onReportReview?.(async () => {
			reviews++;
			return undefined;
		});
		return "";
	};
	services.scheduled = async () => {
		throw Error("Unrelated lookup ran a task");
	};
	await processConversation(ctx, text, "Ada", {}, services);
	expect(reviews).toBe(1);
	expect(spies.replies.map((r) => r.text)).toEqual([
		"Voy a verificar.",
		"Abre a las nueve.",
	]);
});

test("a spontaneous group reply cannot interpret or execute agenda actions", async () => {
	const text = "Inténtalo de nuevo";
	const { ctx, spies } = makeMockContext({
		chatId: ++chatId,
		chatType: "supergroup",
		text,
	});
	const services = dependencies();
	let interpreted = false;
	services.commitments = async () => {
		interpreted = true;
		return "";
	};

	await processConversation(
		ctx,
		text,
		"Ada",
		{ groupAutoReply: true },
		services,
	);

	expect(interpreted).toBe(false);
	expect(spies.replies.map((reply) => reply.text)).toEqual(["Hola, Ana"]);
});

test("queued reminders are compared with the delivered request before chat generation", async () => {
	const id = ++chatId;
	const buffer = await loadSensory(id);
	buffer.allowPhotoRequest = true;
	await saveSensory(buffer);
	const services = dependencies();
	const pendingPhoto = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const errors: unknown[] = [];
	const queue = new ChatUpdateQueue(2, 10, async (error) => {
		errors.push(error);
	});
	const original = "¿Te sacas una selfie?";
	const first = makeMockContext({ chatId: id, messageId: 10, text: original });
	let generations = 0;
	services.generate = async () => "Aquí va [IMAGE_SELF: balcony portrait]";
	services.send = (options) =>
		sendResponse(options, {
			...defaultResponseDependencies,
			baseImage: () => "character.jpg",
			generateImage: async () => {
				generations++;
				return Buffer.from("image");
			},
		});
	first.ctx.replyWithPhoto = async () => {
		pendingPhoto.resolve();
		await delivered.promise;
		return {
			message_id: 14,
			date: 12345,
			photo: [{ file_id: "selfie-fixture" }],
		} as never;
	};
	await queue.enqueue(String(id), async () => {
		await processConversation(first.ctx, original, "Ada", {}, services);
	});
	await pendingPhoto.promise;
	const reminders = [
		"Dale, que seguimos esperando",
		"Cuando puedas, enséñamela",
	];
	const classified: string[] = [];
	services.repeatedSelfie = async (state) => {
		expect(state.originalRequest).toBe("¿Te sacas una selfie?");
		expect(state.sameSpeaker).toBe(true);
		classified.push(state.currentMessage);
		return true;
	};
	services.generate = async () => {
		throw Error("Unexpected second generation");
	};
	for (const [i, text] of reminders.entries()) {
		const { ctx, spies } = makeMockContext({
			chatId: id,
			messageId: 11 + i,
			text,
		});
		await queue.enqueue(String(id), async () => {
			expect(await processConversation(ctx, text, "Ada", {}, services)).toBe(
				false,
			);
			expect(spies.replies).toBeEmpty();
		});
	}
	delivered.resolve();
	await queue.drain();
	expect(errors).toBeEmpty();
	expect(generations).toBe(1);
	expect(classified).toEqual(reminders);
	const text = "La que acabas de mandar no cargó. ¿Me la pasas?";
	const { ctx } = makeMockContext({ chatId: id, messageId: 15, text });
	services.generate = async (prompt) => {
		expect(prompt).toContain("after that selfie");
		expect(prompt).toContain("[SELFIE_RESEND]");
		return "[SELFIE_RESEND]";
	};
	const photos: unknown[] = [];
	ctx.replyWithPhoto = async (photo) => {
		photos.push(photo);
		return {
			message_id: 16,
			date: 12345,
			photo: [{ file_id: "selfie-fixture" }],
		} as never;
	};
	expect(await processConversation(ctx, text, "Ada", {}, services)).toBe(true);
	expect(photos).toEqual(["selfie-fixture"]);
	expect(classified).toEqual(reminders);
});
