import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateBehavior,
	renderBehavior,
	UnverifiableBehaviorEvidence,
} from "../src/commitments/behavior-evaluation.ts";
import {
	type BehaviorServices,
	runTaskBehaviors,
} from "../src/commitments/behavior-runner.ts";
import { localTime } from "../src/commitments/calendar.ts";
import {
	interpretationSchema,
	type ScheduledTask,
} from "../src/commitments/schema.ts";
import { CommitmentStore } from "../src/commitments/store.ts";
import { unwrapVersioned } from "../src/memory/versioning.ts";

let directory: string;
let store: CommitmentStore;
let task: ScheduledTask;
let now: number;
let delivered: string[];
let alerts: string[];
let services: BehaviorServices;
const behavior = {
	condition: "Equipo Azul gana un partido confirmado como final",
	instruction: "Crear un meme creativo de la mascota azul venciendo a la rival",
	output: "image",
	maxPerDay: 1,
	maxEventAgeDays: 2,
};
const proof = "7 de noviembre de 2026: Equipo Azul 5, Equipo Verde 2. Final.";
const event = {
	key: "2026-11-07|azul-verde|partido-1",
	date: "2026-11-07",
	summary: proof,
	evidence: [{ index: 0, quote: proof }],
};
const observation = () => ({
	evidence: [proof],
	persona: "Personaje juguetón",
	checkedAt: now,
});
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "conditional-behaviors-"));
	now = localTime("2026-11-06", "06:00");
	store = new CommitmentStore(join(directory, "commitments.json"), () => now);
	await store.apply(
		{
			chatId: -99,
			userId: 7,
			userName: "Ejemplo",
			messageId: 1,
			text: "Reporte a las 6:30",
		},
		interpretationSchema.parse({
			actions: [
				{
					type: "schedule",
					evidence: "Reporte a las 6:30",
					task: {
						kind: "research",
						instruction: "Resultados y clasificación",
						searchQuery: "liga resultados",
						schedule: {
							frequency: "daily",
							time: "06:30",
							startDate: "2026-11-06",
							weekdays: [0, 1, 2, 3, 4, 5, 6],
						},
					},
				},
			],
		}),
	);
	await store.configureBehaviors((await store.read()).tasks[0]?.id ?? "", [
		behavior,
	]);
	const saved = (await store.read()).tasks[0];
	if (!saved) throw new Error("Missing task");
	task = saved;
	now = localTime("2026-11-07", "06:30");
	delivered = [];
	alerts = [];
	services = {
		store,
		now: () => now,
		evaluate: async () => ({
			outcome: "matched",
			reason: "Final verificado",
			events: [event],
		}),
		render: async () => ({ text: "¡Qué paliza!", image: Buffer.from("meme") }),
		deliver: async (_chat, message) => {
			delivered.push(message.text);
		},
		record: async () => {},
		alert: async (text) => {
			alerts.push(text);
		},
		isOff: () => false,
		isSleeping: () => false,
		isAllowed: () => true,
	};
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("one effect per event across concurrent report/manual runs and restart, with durable send intent", async () => {
	let renders = 0;
	services.render = async () => {
		renders++;
		return { text: "Meme de victoria", image: Buffer.from("meme") };
	};
	services.deliver = async (_chat, message) => {
		const persisted = JSON.parse(await readFile(store.path, "utf8"));
		expect(persisted.data.tasks[0].behaviorEvents[0].status).toBe("sending");
		delivered.push(message.text);
	};
	await Promise.all([
		runTaskBehaviors(task, observation(), services),
		runTaskBehaviors(task, observation(), services),
	]);
	await runTaskBehaviors(task, observation(), {
		...services,
		store: new CommitmentStore(store.path, () => now),
	});
	expect(delivered).toEqual(["Meme de victoria"]);
	expect(renders).toBe(1);
	expect((await store.read()).tasks[0]?.behaviorEvents?.[0]?.status).toBe(
		"sent",
	);
});

test("false or unknown conditions never generate or send an effect", async () => {
	for (const outcome of ["not_matched", "unknown"] as const)
		await runTaskBehaviors(task, observation(), {
			...services,
			evaluate: async () => ({
				outcome,
				reason: "Sin victoria confirmada",
				events: [],
			}),
			render: async () => {
				throw new Error("Unexpected generation");
			},
		});
	expect(delivered).toEqual([]);
	expect(alerts).toEqual([]);
	expect((await store.read()).tasks[0]?.behaviorEvents).toBeUndefined();
});

test("future events, old events and dates preceding authorization cannot trigger effects", async () => {
	for (const date of ["2026-11-08", "2026-11-01", "2026-11-05"])
		await runTaskBehaviors(task, observation(), {
			...services,
			evaluate: async () => ({
				outcome: "matched",
				reason: "Prueba de fechas",
				events: [{ ...event, date }],
			}),
		});
	expect(delivered).toEqual([]);
});

test("daily limits apply across distinct events and reset in the saved timezone", async () => {
	services.evaluate = async () => ({
		outcome: "matched",
		reason: "Dos partidos",
		events: [event, { ...event, key: "second-game" }],
	});
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toHaveLength(1);
	now = localTime("2026-11-08", "06:30");
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toHaveLength(2);
	expect((await store.read()).tasks[0]?.behaviorEvents).toHaveLength(2);
});

test("each creative effect sees the concept just delivered for the previous event", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	await store.configureBehaviors(task.id, [{ ...configured, maxPerDay: 2 }]);
	const saved = (await store.read()).tasks[0];
	if (!saved) throw new Error("Missing task");
	const histories: string[][] = [];
	services.evaluate = async () => ({
		outcome: "matched",
		reason: "Dos partidos",
		events: [event, { ...event, key: "second" }],
	});
	services.render = async (_behavior, _event, _persona, history) => {
		histories.push(history.map((item) => item.concept ?? ""));
		return {
			text: "Meme",
			image: Buffer.from("pixels"),
			creativeConcept: `Concept ${histories.length}`,
			creativeScene: "Scene",
		};
	};
	await runTaskBehaviors(saved, observation(), services);
	expect(histories).toEqual([[], ["Concept 1"]]);
});

test("ambiguous Telegram failure never retries the effect, even next day", async () => {
	let attempts = 0;
	services.render = async () => ({
		text: "Caption",
		image: Buffer.from("meme"),
		creativeConcept: "Nocaut",
		creativeScene: "Ring",
	});
	services.deliver = async () => {
		attempts++;
		throw new Error("timeout after upload");
	};
	await runTaskBehaviors(task, observation(), services);
	now = localTime("2026-11-08", "06:30");
	await runTaskBehaviors(task, observation(), {
		...services,
		store: new CommitmentStore(store.path, () => now),
	});
	expect(attempts).toBe(1);
	expect(alerts).toHaveLength(1);
	expect((await store.read()).tasks[0]?.behaviorEvents?.[0]?.status).toBe(
		"unknown",
	);
	expect(
		(await store.read()).tasks[0]?.behaviorEvents?.[0]?.creativeConcept,
	).toBe("Nocaut");
	expect(
		(await store.read()).tasks[0]?.behaviorEvents?.[0]?.imageDigest,
	).toHaveLength(64);
});

test("generation failure counts against the daily budget but may retry next day", async () => {
	let attempts = 0;
	services.render = async () => {
		attempts++;
		throw new Error("Image provider down");
	};
	await runTaskBehaviors(task, observation(), services);
	await runTaskBehaviors(task, observation(), services);
	expect(attempts).toBe(1);
	now = localTime("2026-11-08", "06:30");
	await runTaskBehaviors(task, observation(), services);
	expect(attempts).toBe(2);
	expect(delivered).toEqual([]);
	expect(
		(await store.read()).tasks[0]?.behaviorEvents?.[0]?.attempts,
	).toHaveLength(2);
});

test("disabling a behavior during generation prevents its send", async () => {
	services.render = async () => {
		await store.configureBehaviors(task.id, []);
		return { text: "Obsoleto", image: Buffer.from("meme") };
	};
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toEqual([]);
});

for (const guard of ["isOff", "isSleeping", "isAllowed", "expiry"] as const) {
	test(`the ${guard} guard is checked again after generation`, async () => {
		let changed = false;
		const guarded = {
			...services,
			isOff: () => guard === "isOff" && changed,
			isSleeping: () => guard === "isSleeping" && changed,
			isAllowed: () => !(guard === "isAllowed" && changed),
			render: async () => {
				changed = true;
				if (guard === "expiry") now = task.expiresAt + 1;
				return { text: "Hola", image: Buffer.from("meme") };
			},
		};
		await runTaskBehaviors(task, observation(), guarded);
		expect(changed).toBe(true);
		expect(delivered).toEqual([]);
	});
}

test("failed send-intent persistence blocks Telegram and history failure cannot cause replay", async () => {
	const persist = store.persist.bind(store);
	store.persist = async (state) => {
		if (state.tasks[0]?.behaviorEvents?.[0]?.status === "sending")
			throw new Error("disk full");
		await persist(state);
	};
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toEqual([]);
	store.persist = persist;
	now = localTime("2026-11-08", "06:30");
	services.record = async () => {
		throw new Error("history disk full");
	};
	await runTaskBehaviors(task, observation(), services);
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toHaveLength(1);
});

test("versioned persistence protects behaviors and receipts against older writers and reads v1", async () => {
	const raw = JSON.parse(await readFile(store.path, "utf8"));
	expect(raw.schemaVersion).toBe(3);
	expect(() => unwrapVersioned(raw, 2)).toThrow("Unsupported");
	expect(() => unwrapVersioned(raw)).toThrow("Unsupported");
	await Bun.write(store.path, JSON.stringify({ ...raw, schemaVersion: 1 }));
	expect((await store.read()).tasks[0]?.behaviors).toEqual(task.behaviors);
});

test("chat configuration enforces ownership and evidence; schedule edits preserve receipt history", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	const request = {
		chatId: task.chatId,
		userId: 7,
		userName: "Ejemplo",
		messageId: 2,
		text: "Cambia la broma",
	};
	const plan = interpretationSchema.parse({
		actions: [
			{
				type: "set_behaviors",
				id: task.id,
				behaviors: [{ ...configured, instruction: "Crear otra broma" }],
				evidence: request.text,
			},
		],
	});
	await expect(store.apply({ ...request, chatId: -100 }, plan)).rejects.toThrow(
		"propias",
	);
	await expect(
		store.apply({ ...request, text: "No autoricé esto" }, plan),
	).rejects.toThrow("verificar");
	await store.apply(request, plan);
	const saved = (await store.read()).tasks[0];
	expect(saved?.schedule).toEqual(task.schedule);
	expect(saved?.expiresAt).toBe(task.expiresAt);
	expect(saved?.behaviors?.[0]?.id).toBe(configured.id);
	if (!saved) throw new Error("Missing task");
	await runTaskBehaviors(saved, observation(), services);
	const next = { ...request, messageId: 3, text: "Cambia a las 8" };
	await store.apply(
		next,
		interpretationSchema.parse({
			actions: [
				{
					type: "schedule",
					replaceId: task.id,
					evidence: next.text,
					task: {
						kind: "research",
						instruction: task.instruction,
						searchQuery: task.searchQuery,
						schedule: { ...task.schedule, time: "08:00" },
					},
				},
			],
		}),
	);
	const replacement = (await store.read()).tasks.find(
		(t) => t.status === "active",
	);
	expect(replacement?.behaviors).toEqual(saved.behaviors);
	expect(replacement?.behaviorEvents?.[0]?.status).toBe("sent");
	if (!replacement) throw new Error("Missing replacement");
	await runTaskBehaviors(replacement, observation(), services);
	expect(delivered).toHaveLength(1);
});

test("invalid headless configuration rolls back atomically", async () => {
	const before = await readFile(store.path, "utf8");
	for (const invalid of [
		[{ ...behavior, maxPerDay: 99 }],
		[{ ...behavior, id: "fabricated" }],
		[behavior, behavior, behavior, behavior],
	]) {
		await expect(store.configureBehaviors(task.id, invalid)).rejects.toThrow();
		expect(await readFile(store.path, "utf8")).toBe(before);
	}
});

test("stale preparing claims can recover within limits; interrupted send intents cannot", async () => {
	const id = task.behaviors?.[0]?.id;
	if (!id) throw new Error("Missing behavior");
	await store.transaction((state) => {
		const current = state.tasks[0];
		if (!current) throw new Error("Missing task");
		current.behaviorEvents = [
			{
				behaviorId: id,
				eventKey: event.key,
				summary: event.summary,
				date: event.date,
				status: "preparing",
				attempts: [now - 86400000],
				updatedAt: now - 86400000,
			},
		];
	});
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toHaveLength(1);
	await store.transaction((state) => {
		const receipt = state.tasks[0]?.behaviorEvents?.[0];
		if (receipt) receipt.status = "sending";
	});
	await runTaskBehaviors(task, observation(), services);
	expect(delivered).toHaveLength(1);
	expect((await store.read()).tasks[0]?.behaviorEvents?.[0]?.status).toBe(
		"unknown",
	);
});

function proposeMatch(passageIds: number[]) {
	return JSON.stringify({
		outcome: "matched",
		reason: "Final",
		events: [
			{ key: event.key, summary: event.summary, date: event.date, passageIds },
		],
	});
}

for (const levels of [0, 1, 2]) {
	test(`a win in a table serialized ${levels} times reaches meme delivery with original evidence`, async () => {
		const table =
			'2026-11-07\nFinal\tC\tH\tE\nEquipo Verde\t2\t7\t0\nEquipo Azul\t5\t11\t0\nNota: "final confirmado"';
		let source = table;
		for (let level = 0; level < levels; level++)
			source = JSON.stringify({ content: source });
		const evidence = ["Unrelated page", source];
		services.evaluate = (behavior, sources, previous, date) =>
			evaluateBehavior(
				behavior,
				sources,
				previous,
				date,
				async (_system, messages) => {
					const input = JSON.parse(messages[0]?.content ?? "{}");
					if (input.passages) {
						expect(input.passages[1]).toEqual({
							id: 1,
							index: 1,
							quote: source,
						});
						return proposeMatch([1]);
					}
					expect(input.events[0].evidence).toEqual([
						{ index: 1, quote: source },
					]);
					expect(messages).toHaveLength(1);
					expect(input).not.toHaveProperty("previousEvents");
					return JSON.stringify({ supportedKeys: [event.key] });
				},
			);
		await runTaskBehaviors(task, { ...observation(), evidence }, services);
		expect(alerts).toEqual([]);
		expect(delivered).toHaveLength(1);
		expect((await store.read()).tasks[0]?.behaviorEvents?.[0]?.status).toBe(
			"sent",
		);
	});
}

for (const hasFinal of [true, false]) {
	test(`citation repair ${hasFinal ? "recovers the verified win" : "keeps an in-progress score from triggering the meme"}`, async () => {
		const evidence = [
			"7 de noviembre de 2026. En el séptimo: Equipo Azul 5, Equipo Verde 2.",
			hasFinal ? proof : "Noveno inning. Partido todavía en curso.",
		];
		let reviews = 0;
		let repairs = 0;
		services.evaluate = (behavior, sources, previous, date) =>
			evaluateBehavior(
				behavior,
				sources,
				previous,
				date,
				async (_system, messages, operation) => {
					const input = JSON.parse(messages[0]?.content ?? "{}");
					if (operation === "behavior-evaluation") return proposeMatch([0]);
					if (operation === "behavior-evidence-recovery") {
						repairs++;
						expect(
							input.passages.map((p: { quote: string }) => p.quote),
						).toEqual(evidence);
						expect(
							JSON.parse(messages[1]?.content ?? "{}").rejected[0].key,
						).toBe(event.key);
						return proposeMatch([1]);
					}
					expect(operation).toBe("behavior-evidence-review");
					expect(input).not.toHaveProperty("passages");
					expect(input.events[0].evidence).toEqual([
						{ index: reviews, quote: evidence[reviews] },
					]);
					reviews++;
					return JSON.stringify({
						supportedKeys: reviews === 2 && hasFinal ? [event.key] : [],
					});
				},
			);
		await runTaskBehaviors(task, { ...observation(), evidence }, services);
		expect(repairs).toBe(1);
		expect(reviews).toBe(2);
		expect(delivered).toHaveLength(hasFinal ? 1 : 0);
		expect(alerts).toEqual([]);
	});
}

test("evaluation repairs an invalid passage ID and fails closed if repair also fails", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	for (const repair of [true, false]) {
		let calls = 0;
		const result = evaluateBehavior(
			configured,
			[proof],
			[],
			"2026-11-08",
			async (_system, messages) => {
				calls++;
				if (calls === 1) return proposeMatch([9]);
				if (calls === 2) {
					expect(messages.at(-1)?.content).toContain(
						"Unknown event evidence passage ID 9",
					);
					return proposeMatch([repair ? 0 : 9]);
				}
				return JSON.stringify({ supportedKeys: [event.key] });
			},
		);
		if (repair) {
			expect((await result).events[0]?.evidence).toEqual(event.evidence);
			expect(calls).toBe(3);
		} else {
			await expect(result).rejects.toThrow(
				"Unknown event evidence passage ID 9",
			);
			expect(calls).toBe(2);
		}
	}
});

test("passages retain source indices and reserve budget for a late final score", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	const source = `${"x".repeat(999)}🏆${proof}`;
	const result = await evaluateBehavior(
		configured,
		[source, "z".repeat(64000), proof],
		[],
		"2026-11-08",
		async (_system, messages) => {
			const input = JSON.parse(messages[0]?.content ?? "{}");
			if (input.passages) {
				const passages: { index: number; quote: string }[] = input.passages;
				expect(
					passages
						.filter((p) => p.index === 0)
						.map((p) => p.quote)
						.join(""),
				).toBe(source);
				expect(passages[1]?.quote).toBe(`🏆${proof}`);
				expect(passages.map((p) => p.quote).join("")).toHaveLength(64000);
				expect(
					passages.filter((p) => p.index === 2).map((p) => p.quote),
				).toEqual([proof]);
				return proposeMatch([0, 1]);
			}
			expect(
				input.events[0].evidence
					.map((p: { quote: string }) => p.quote)
					.join(""),
			).toBe(source);
			return JSON.stringify({ supportedKeys: [event.key] });
		},
	);
	expect(result.events[0]?.key).toBe(event.key);
});

test("evaluation alerts identify the failing stage and reason without attempting image generation", async () => {
	let renders = 0;
	await runTaskBehaviors(task, observation(), {
		...services,
		evaluate: async () => {
			throw new UnverifiableBehaviorEvidence(2);
		},
		render: async () => {
			renders++;
			return { text: "Unexpected" };
		},
	});
	expect(renders).toBe(0);
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toContain("evaluation failed");
	expect(alerts[0]).toContain("Unknown event evidence passage ID 2");
	expect(delivered).toEqual([]);
});

test("only reviewed event keys survive a mixed batch, and an unknown review key fails closed", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	for (const supportedKey of [event.key, "unproposed"]) {
		const result = evaluateBehavior(
			configured,
			[proof, "Segundo juego en curso"],
			[],
			"2026-11-07",
			async (_system, _messages, operation) => {
				if (operation === "behavior-evidence-recovery")
					return '{"outcome":"unknown","reason":"No final score","events":[]}';
				if (operation === "behavior-evidence-review")
					return JSON.stringify({ supportedKeys: [supportedKey] });
				const batch = JSON.parse(proposeMatch([0]));
				batch.events.push({
					...batch.events[0],
					key: "second-game",
					passageIds: [1],
				});
				return JSON.stringify(batch);
			},
		);
		if (supportedKey === event.key)
			expect((await result).events).toEqual([event]);
		else await expect(result).rejects.toThrow("unknown event key");
	}
});

test("creative rendering receives verified facts, honors output modality and does not need full access", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	let imageCalls = 0;
	const result = await renderBehavior(
		configured,
		event,
		"Persona",
		[{ text: "Broma anterior" }],
		async (_system, messages) => {
			expect(messages[0]?.content).toContain(proof);
			expect(messages[0]?.content).toContain("Broma anterior");
			return JSON.stringify({
				text: "¡Ganamos!",
				concept: "Victoria en el ring",
				scene: "Mascotas boxeadoras",
				imagePrompt: "Mascotas en un ring de caricatura, Azul 5-2 Verde",
			});
		},
		async (_prompt, reference, options) => {
			imageCalls++;
			expect(reference).toBeUndefined();
			expect(options?.allowText).toBe(true);
			return Buffer.from("pixels");
		},
		async () => ({ distinct: true, reason: "New concept" }),
	);
	expect(result.image?.length).toBeGreaterThan(0);
	expect(imageCalls).toBe(1);
	const text = await renderBehavior(
		{ ...configured, output: "text" },
		event,
		"Persona",
		[],
		async () =>
			'{"text":"¡Ganamos!","concept":"Felicitación","scene":"","imagePrompt":null}',
		async () => {
			throw new Error("Unexpected image");
		},
	);
	expect(text).toMatchObject({
		text: "¡Ganamos!",
		creativeConcept: "Felicitación",
	});
});
