import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateBehavior,
	renderBehavior,
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

test("v2 persistence protects behaviors and receipts against older writers and reads v1", async () => {
	const raw = JSON.parse(await readFile(store.path, "utf8"));
	expect(raw.schemaVersion).toBe(2);
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

test("evaluation validates verbatim tool evidence and retains event identities across different wording", async () => {
	const configured = task.behaviors?.[0];
	if (!configured) throw new Error("Missing behavior");
	let calls = 0;
	const decision = await evaluateBehavior(
		configured,
		[proof],
		[],
		"2026-11-07",
		async () => {
			calls++;
			return JSON.stringify({
				outcome: "matched",
				reason: "Final",
				events: [
					{
						...event,
						evidence: [
							{
								index: 0,
								quote:
									calls === 1 ? "Invented result absent from evidence" : proof,
							},
						],
					},
				],
			});
		},
	);
	expect(calls).toBe(2);
	expect(decision.events[0]?.key).toBe(event.key);
	await expect(
		evaluateBehavior(configured, [proof], [], "2026-11-07", async () =>
			JSON.stringify({
				outcome: "matched",
				reason: "Forged",
				events: [{ ...event, evidence: [{ index: 9, quote: proof }] }],
			}),
		),
	).rejects.toThrow();
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
