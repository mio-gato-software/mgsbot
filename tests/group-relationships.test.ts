import { expect, mock, spyOn, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	classifyGroupRelationshipTurn,
	type GroupRelationshipClassifierInput,
	type GroupRelationshipDecision,
} from "../src/ai/group-relationship-classifier.ts";
import { getOpenAIClient } from "../src/ai/openai-client.ts";
import {
	CONSERVATIVE_GROUP_POSTURE,
	type GroupRelationshipTurn,
	recordGroupRelationshipTurn,
} from "../src/group-relationships.ts";
import { memoryPath } from "../src/runtime-paths.ts";

let chatId = -930_000;

function turn(
	chat: number,
	messageId: number,
	text: string,
	userId = 1,
): GroupRelationshipTurn {
	return {
		chatId: chat,
		userId,
		messageId,
		messageAt: messageId * 6 * 60_000,
		userName: "Lucía Ejemplo",
		botName: "Bot Ejemplo",
		text,
		recentMessages: [],
	};
}

function assess(decision: GroupRelationshipDecision) {
	return async () => ({ boundary: "none" as const, ...decision });
}

test("rapport and respect advance independently over distinct exchanges and the room wins", async () => {
	const chat = --chatId;
	const reciprocal = assess({ room: "playful", rapport: "builds" });
	const first = turn(
		chat,
		1,
		"Me ganaste ese round, pero te espero en la revancha.",
	);
	expect(await recordGroupRelationshipTurn(first, reciprocal)).toMatchObject({
		banter: "light",
		respect: "neutral",
	});
	const repeat = turn(chat, 2, "¡Y sin excusas!");
	repeat.messageAt = first.messageAt;
	await recordGroupRelationshipTurn(repeat, reciprocal);
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 3, "Te salió esa, Bot Ejemplo."),
			reciprocal,
		),
	).toMatchObject({ banter: "light" });
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 4, "Ya vi que hoy viniste afilada."),
			reciprocal,
		),
	).toMatchObject({ banter: "familiar" });

	const considerate = assess({ room: "neutral", regard: "consideration" });
	await recordGroupRelationshipTurn(
		turn(chat, 5, "Dani, yo termino mi parte y te cubro mientras descansas."),
		considerate,
	);
	const serious = turn(
		chat,
		6,
		"Dani, tómate tu tiempo. Si quieres, me quedo contigo.",
	);
	serious.replyTo = {
		recipient: "human",
		text: "Hoy estoy pasando un mal momento.",
	};
	expect(await recordGroupRelationshipTurn(serious, considerate)).toMatchObject(
		{
			banter: "none",
			respect: "earned",
		},
	);
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 7, "Yo veo el tema distinto."),
			assess({ room: "neutral" }),
		),
	).toMatchObject({
		banter: "none",
		respect: "earned",
	});
});

test("clear mistreatment and a genuine repair affect respect without turning into retaliation", async () => {
	const chat = --chatId;
	const disrespect = turn(
		chat,
		1,
		"Dani, voy a seguir poniéndote en ridículo aunque te moleste.",
	);
	disrespect.replyTo = { recipient: "human", text: "Ya te pedí que pararas." };
	expect(
		await recordGroupRelationshipTurn(
			disrespect,
			assess({ regard: "mistreatment", room: "playful" }),
		),
	).toMatchObject({
		banter: "none",
		respect: "guarded",
	});
	const repair = turn(
		chat,
		2,
		"Perdón. Te hice pasar un mal rato y debí parar cuando me lo pediste.",
	);
	repair.messageAt = disrespect.messageAt;
	expect(
		await recordGroupRelationshipTurn(
			repair,
			assess({ regard: "repair", room: "sensitive" }),
		),
	).toMatchObject({
		banter: "none",
		respect: "neutral",
	});
});

test("a durable personal stop takes effect immediately and only that member can reopen it", async () => {
	const chat = --chatId;
	const stopped = turn(chat, 1, "Ya no quiero que me cojas de relajo.");
	const stopDecision = assess({
		boundary: "stop_all",
		room: "playful",
		regard: "mistreatment",
	});
	expect(await recordGroupRelationshipTurn(stopped, stopDecision)).toEqual({
		banter: "none",
		respect: "neutral",
		boundary: "avoid_teasing",
		boundaryChange: "stop",
	});
	const casual = assess({ room: "playful", rapport: "builds" });
	const renamed = {
		...turn(chat, 2, "Esa sí te quedó buena."),
		userName: "Lucía",
	};
	expect(await recordGroupRelationshipTurn(renamed, casual)).toMatchObject({
		banter: "none",
		boundary: "avoid_teasing",
	});
	expect(
		await recordGroupRelationshipTurn(
			turn(--chatId, 3, "Esa sí te quedó buena."),
			casual,
		),
	).toMatchObject({ banter: "light", boundary: "none" });
	await recordGroupRelationshipTurn(
		turn(chat, 3, "Conmigo vuelve al relajo.", 2),
		assess({ boundary: "reopen_all" }),
	);
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 4, "¿Y esa ocurrencia?"),
			async () => null,
		),
	).toMatchObject({ banter: "none", boundary: "avoid_teasing" });
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 5, "Ya puedes volver a hacerme coro como antes."),
			assess({ boundary: "reopen_all" }),
		),
	).toMatchObject({ boundary: "none", boundaryChange: "reopen" });
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 6, "Suelta tu mejor pulla."),
			casual,
		),
	).toMatchObject({ banter: "light", boundary: "none" });
});

test("topic limits are scoped to the speaker and survive a general reopening", async () => {
	const chat = --chatId;
	const scope = turn(
		chat,
		1,
		"La próxima, no me relajes por mi récord de boliche.",
	);
	const stopped = await recordGroupRelationshipTurn(
		scope,
		assess({ boundary: "stop_topic" }),
	);
	expect(stopped).toMatchObject({
		banter: "none",
		boundary: "avoid_topic_teasing",
		boundaryChange: "stop",
	});
	expect(JSON.stringify(stopped)).not.toContain("boliche");

	const ownTopic = turn(chat, 2, "Vuelvo a la bolera esta tarde.");
	const ownAssessment = mock(
		async (
			_input: GroupRelationshipClassifierInput,
		): Promise<GroupRelationshipDecision> => ({
			room: "playful",
			boundary: "none",
			matchedTopic: scope.messageId,
		}),
	);
	expect(
		await recordGroupRelationshipTurn(ownTopic, ownAssessment),
	).toMatchObject({ banter: "none", boundary: "avoid_topic_teasing" });
	expect(ownAssessment.mock.calls[0]?.[0].topicBoundaries).toEqual([
		{ id: scope.messageId, evidence: scope.text },
	]);

	const otherUser = {
		...turn(chat, 3, "Vuelvo a la bolera esta tarde.", 2),
		userName: scope.userName,
	};
	expect(
		await recordGroupRelationshipTurn(
			otherUser,
			async ({ topicBoundaries }) => {
				expect(topicBoundaries).toEqual([]);
				return { room: "playful", boundary: "none" };
			},
		),
	).toMatchObject({ banter: "light", boundary: "none" });
	await recordGroupRelationshipTurn(
		turn(chat, 4, "Vuelve a relajarme en general."),
		assess({ boundary: "reopen_all" }),
	);
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 5, "¿Me tengo que apuntar al campeonato?"),
			assess({ room: "playful" }),
		),
	).toMatchObject({ banter: "none", boundary: "avoid_topic_teasing" });
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 6, "Tu pronóstico de hoy estuvo de concurso."),
			assess({ room: "playful", matchedTopic: "none" }),
		),
	).toMatchObject({ banter: "light", boundary: "none" });
	await recordGroupRelationshipTurn(
		turn(chat, 7, "Ya puedes relajarme con las veces que tiro al canal.", 2),
		assess({ boundary: "reopen_topic", matchedTopic: scope.messageId }),
	);
	expect(
		await recordGroupRelationshipTurn(
			turn(
				chat,
				8,
				"Ahora sí te doy luz verde para burlarte de mi récord en la bolera.",
			),
			assess({ boundary: "reopen_topic", matchedTopic: scope.messageId }),
		),
	).toMatchObject({ boundary: "none", boundaryChange: "reopen" });
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 9, "¿Algún pronóstico para mi próximo juego?"),
			assess({ room: "playful" }),
		),
	).toMatchObject({ banter: "light", boundary: "none" });
});

test("a referenced boundary remembers the bounded Telegram reply context", async () => {
	const chat = --chatId;
	const stop = {
		...turn(chat, 1, "Ya no me relajes con eso."),
		replyTo: {
			recipient: "bot" as const,
			text: "¿Volviste a llegar al ensayo con dos zapatos distintos?",
		},
	};
	await recordGroupRelationshipTurn(
		stop,
		assess({ boundary: "stop_context_topic" }),
	);
	const classify = mock(
		async (
			_input: GroupRelationshipClassifierInput,
		): Promise<GroupRelationshipDecision> => ({
			boundary: "none",
			matchedTopic: stop.messageId,
		}),
	);
	await recordGroupRelationshipTurn(
		turn(chat, 2, "Lo de mis tenis de colores es sagrado."),
		classify,
	);
	expect(classify.mock.calls[0]?.[0].topicBoundaries).toEqual([
		{ id: stop.messageId, evidence: stop.text, context: [stop.replyTo.text] },
	]);
});

test("the same source is assessed once across passive and replying calls, with no unbounded replay log", async () => {
	const chat = --chatId;
	const before = turn(chat, 1, "A ver si te sale una pulla mejor.");
	expect(
		await recordGroupRelationshipTurn(before, assess({ room: "playful" })),
	).toMatchObject({ banter: "light" });
	const source = turn(chat, 2, "Ya baja el relajo conmigo.");
	const classifier = mock(assess({ boundary: "stop_all" }));
	const decisions = await Promise.all([
		recordGroupRelationshipTurn(source, classifier),
		recordGroupRelationshipTurn(
			{ ...source, addressedToBot: true },
			classifier,
		),
	]);
	expect(decisions[0]).toEqual(decisions[1]);
	expect(classifier).toHaveBeenCalledTimes(1);
	const replay = mock(assess({ boundary: "reopen_all" }));
	expect(await recordGroupRelationshipTurn(before, replay)).toMatchObject({
		banter: "none",
		boundary: "avoid_teasing",
	});
	for (let index = 3; index <= 15; index++) {
		await recordGroupRelationshipTurn(
			turn(chat, index, "Un mensaje corriente."),
			assess({}),
		);
	}
	expect(await recordGroupRelationshipTurn(source, replay)).toMatchObject({
		banter: "none",
		boundary: "avoid_teasing",
	});
	expect(replay).not.toHaveBeenCalled();
	const contents = await readFile(
		memoryPath("group-relationships", String(chat), "1.json"),
		"utf8",
	);
	expect(contents).not.toContain(source.text);
	expect(contents).not.toContain("Un mensaje corriente.");
});

test("missing authored group text or damaged state cannot trigger a classification or overwrite", async () => {
	const chat = --chatId;
	const dir = memoryPath("group-relationships", String(chat));
	const path = memoryPath("group-relationships", String(chat), "1.json");
	await mkdir(dir, { recursive: true });
	await writeFile(path, "{damaged", "utf8");
	const classifier = mock(assess({ boundary: "reopen_all" }));
	expect(
		await recordGroupRelationshipTurn(
			turn(chat, 1, "Texto humano"),
			classifier,
		),
	).toEqual(CONSERVATIVE_GROUP_POSTURE);
	expect(
		await recordGroupRelationshipTurn(turn(chat, 2, "   "), classifier),
	).toEqual(CONSERVATIVE_GROUP_POSTURE);
	expect(
		await recordGroupRelationshipTurn(turn(123, 3, "DM"), classifier),
	).toEqual(CONSERVATIVE_GROUP_POSTURE);
	expect(classifier).not.toHaveBeenCalled();
	expect(await readFile(path, "utf8")).toBe("{damaged");
});

test("Decisions receives bounded attributed context and low confidence does not reopen a limit", async () => {
	const oldProvider = process.env.CLASSIFIER_PROVIDER;
	const oldKey = process.env.OPENAI_API_KEY;
	process.env.CLASSIFIER_PROVIDER = "openai-decisions";
	process.env.OPENAI_API_KEY = "example-key";
	const decisions = getOpenAIClient().decisions;
	let candidate: { choice: string; confidence: number } = {
		choice: "reopen_topic",
		confidence: 0.6,
	};
	let probability = 0.72;
	const create = spyOn(decisions, "create").mockImplementation((async (
		request: Parameters<typeof decisions.create>[0],
	) => ({
		status: "completed",
		answers: request.questions.map((question) => {
			if (question.type === "predicate") {
				return { name: question.name, type: "predicate", probability };
			}
			let choice = "none";
			if (question.name === "boundary") {
				return { name: question.name, type: "choice", ...candidate };
			}
			if (question.name === "room") choice = "playful";
			if (question.name === "topic") choice = "topic_1";
			return { name: question.name, type: "choice", choice, confidence: 0.98 };
		}),
	})) as unknown as typeof decisions.create);
	try {
		const input = {
			...turn(--chatId, 2, `${"🟠".repeat(800)} Ya podemos darle al boliche.`),
			replyTo: { recipient: "human" as const, text: "¿Cómo va tu puntuación?" },
			recentMessages: [
				{
					role: "user" as const,
					userId: 2,
					name: "Dani Ejemplo",
					userText: "¿Cómo va tu puntuación?",
					userTextVerified: true as const,
					content: "UNTRUSTED WRAPPER",
					timestamp: 0,
				},
				{
					role: "user" as const,
					userId: 3,
					content: "UNVERIFIED LEGACY",
					timestamp: 1,
				},
			],
			topicBoundaries: [
				{
					id: 1,
					evidence: "No me vaciles por mi récord.",
					context: ["El récord de boliche."],
				},
			],
		};
		expect(await classifyGroupRelationshipTurn(input)).toEqual({
			rapport: "none",
			regard: "none",
			boundary: undefined,
			room: "playful",
			matchedTopic: 1,
		});
		const wireInput = JSON.stringify(create.mock.calls[0]?.[0]);
		expect(wireInput).toContain("Ya podemos darle al boliche.");
		expect(wireInput).toContain('"recipient":"human"');
		expect(wireInput).toContain("El récord de boliche.");
		expect(wireInput).not.toContain("UNTRUSTED WRAPPER");
		expect(wireInput).not.toContain("UNVERIFIED LEGACY");
		expect(create).toHaveBeenCalledTimes(2);

		candidate = { choice: "stop_topic", confidence: 0.52 };
		probability = 0.96;
		const explicitlyLimited = {
			...input,
			text: "Bot Ejemplo, dale al relajo conmigo. Lo de mi familia sí déjalo fuera de los chistes siempre.",
			topicBoundaries: [],
		};
		expect(
			await classifyGroupRelationshipTurn(explicitlyLimited),
		).toMatchObject({ boundary: "stop_topic" });
		const confirmation = create.mock.calls[3]?.[0];
		expect(confirmation?.questions).toHaveLength(1);
		expect(confirmation?.questions[0]).toMatchObject({
			name: "boundary_confirmation",
			type: "predicate",
		});
		expect(JSON.stringify(confirmation?.input)).toContain(
			explicitlyLimited.text,
		);

		candidate = { choice: "none", confidence: 0.52 };
		expect(
			await classifyGroupRelationshipTurn({
				...explicitlyLimited,
				text: "¿Con quién estás hablando?",
			}),
		).toMatchObject({ boundary: undefined });
		expect(create).toHaveBeenCalledTimes(5);

		create.mockImplementation((async (
			request: Parameters<typeof decisions.create>[0],
		) => ({
			status: "completed",
			answers: request.questions.map((question) => {
				let choice = "none";
				if (question.name === "boundary") choice = "reopen_topic";
				if (question.name === "room") choice = "neutral";
				if (
					question.type === "choice" &&
					question.choices.some((option) => option.value === "topic_1")
				)
					choice = "topic_1";
				return {
					name: question.name,
					type: "choice",
					confidence: 0.97,
					choice,
				};
			}),
		})) as unknown as typeof decisions.create);
		expect(
			await classifyGroupRelationshipTurn({
				...input,
				text: "Si quieres, puedes volver a relajarme con mi puntuación de boliche.",
				topicBoundaries: [
					...input.topicBoundaries,
					...Array.from({ length: 20 }, (_, index) => ({
						id: index + 2,
						evidence: `No hagas chistes sobre el tema ${index + 2}.`,
					})),
				],
			}),
		).toMatchObject({ boundary: "reopen_topic", matchedTopic: 1 });
		expect(create).toHaveBeenCalledTimes(7);
	} finally {
		create.mockRestore();
		if (oldProvider === undefined) delete process.env.CLASSIFIER_PROVIDER;
		else process.env.CLASSIFIER_PROVIDER = oldProvider;
		if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = oldKey;
	}
});
