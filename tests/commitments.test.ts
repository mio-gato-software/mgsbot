import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	localTime,
	monthDeadline,
	nextOccurrence,
	scheduleSchema,
} from "../src/commitments/calendar.ts";
import {
	handleCommitmentRequest,
	writtenDomains,
} from "../src/commitments/requests.ts";
import { interpretationSchema } from "../src/commitments/schema.ts";
import {
	CommitmentStore,
	containsDomain,
	matchingPreferences,
	type RequestIdentity,
} from "../src/commitments/store.ts";

let root: string;
let store: CommitmentStore;
let now = localTime("2026-10-22", "21:02");
const oldEnv = {
	enabled: process.env.ENABLE_COMMITMENTS,
	group: process.env.ALLOWED_GROUP_ID,
	owner: process.env.OWNER_USER_ID,
};
const input: RequestIdentity = {
	chatId: -99,
	userId: 7,
	userName: "Ejemplo",
	messageId: 1,
	text: "Todos los días a las 7am dinos el resultado de la pelota en bengaleses.com y a las 10pm los juegos de mañana.",
};
const plan = (actions: unknown[], extra = {}) =>
	interpretationSchema.parse({ actions, ...extra });
const action = (time = "07:00") => ({
	type: "schedule",
	evidence: input.text,
	task: {
		instruction:
			time === "07:00"
				? "Resultados de ayer de la LIDOM"
				: "Juegos de mañana de la LIDOM",
		kind: "research",
		searchQuery: "LIDOM resultados ayer",
		domains: ["bengaleses.com"],
		schedule: {
			frequency: "daily",
			time,
			startDate: "2026-10-22",
			weekdays: [0, 1, 2, 3, 4, 5, 6],
		},
	},
});
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "commitments-"));
	now = localTime("2026-10-22", "21:02");
	store = new CommitmentStore(join(root, "state.json"), () => now);
	process.env.ENABLE_COMMITMENTS = "true";
	process.env.ALLOWED_GROUP_ID = "-99";
	process.env.OWNER_USER_ID = "1";
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries({
		ENABLE_COMMITMENTS: oldEnv.enabled,
		ALLOWED_GROUP_ID: oldEnv.group,
		OWNER_USER_ID: oldEnv.owner,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("two requested times are persisted atomically, finite, source-complete and idempotent", async () => {
	const result = await store.apply(input, plan([action(), action("22:00")]));
	const reloaded = new CommitmentStore(store.path, () => now);
	const tasks = (await reloaded.read()).tasks;
	expect(tasks).toHaveLength(2);
	expect(tasks.map((t) => t.nextRunAt)).toEqual([
		localTime("2026-10-23", "07:00"),
		localTime("2026-10-22", "22:00"),
	]);
	expect(
		tasks.every(
			(t) =>
				t.expiresAt === monthDeadline(now) && t.domains[0] === "bengaleses.com",
		),
	).toBe(true);
	expect(result).toContain("2026-11-22");
	expect(await reloaded.apply(input, plan([action()]))).toBe(result);
	expect((await store.read()).tasks).toHaveLength(2);
});

test("weekends, specific weekdays, end dates, DST and month ends are calendar-based", () => {
	const weekdays = scheduleSchema.parse({
		frequency: "daily",
		time: "07:00",
		startDate: "2026-10-23",
		weekdays: [1, 2, 3, 4, 5],
	});
	expect(
		nextOccurrence(
			weekdays,
			localTime("2026-10-23", "08:00"),
			monthDeadline(now),
		),
	).toBe(localTime("2026-10-26", "07:00"));
	expect(
		nextOccurrence(
			{ ...weekdays, weekdays: [1] },
			localTime("2026-10-26", "08:00"),
			monthDeadline(now),
		),
	).toBe(localTime("2026-11-02", "07:00"));
	expect(nextOccurrence(weekdays, now, now)).toBeUndefined();
	const ny = "America/New_York";
	expect(
		nextOccurrence(
			{ ...weekdays, weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-10-31" },
			localTime("2026-10-31", "08:00", ny),
			localTime("2026-11-03", "08:00", ny),
			ny,
		),
	).toBe(localTime("2026-11-01", "07:00", ny));
	expect(monthDeadline(localTime("2026-01-31", "10:00"))).toBe(
		localTime("2026-02-28", "10:00"),
	);
	expect(Number.isNaN(localTime("2026-03-08", "02:30", ny))).toBe(true);
	expect(
		scheduleSchema.safeParse({ ...weekdays, startDate: "2026-02-30" }).success,
	).toBe(false);
});

test("invalid second task rolls back the whole batch; past dates and ungrounded domains are rejected", async () => {
	const invalid = action("22:00");
	invalid.task.schedule.startDate = "2027-01-01";
	await expect(store.apply(input, plan([action(), invalid]))).rejects.toThrow(
		"futuras",
	);
	expect((await store.read()).tasks).toHaveLength(0);
	const fabricated = action();
	fabricated.task.domains = ["madeup.com"];
	await expect(store.apply(input, plan([fabricated]))).rejects.toThrow(
		"direcciones",
	);
	expect(containsDomain("evilbengaleses.com", "bengaleses.com")).toBe(false);
});

test("task management is scoped to chat and creator/owner, renewal is explicit and bounded", async () => {
	await store.apply(input, plan([action()]));
	const id = (await store.read()).tasks[0]?.id;
	const cancellation = plan([
		{ type: "cancel", ids: [id], evidence: "cancela" },
	]);
	await expect(
		store.apply(
			{ ...input, userId: 8, messageId: 2, text: "cancela" },
			cancellation,
		),
	).rejects.toThrow("propias");
	await expect(
		store.apply(
			{ ...input, chatId: -100, messageId: 2, text: "cancela" },
			cancellation,
		),
	).rejects.toThrow("propias");
	now = localTime("2026-11-23", "10:00");
	await store.apply(
		{ ...input, messageId: 3, text: "sigue otro mes" },
		plan([{ type: "renew", ids: [id], evidence: "sigue otro mes" }]),
	);
	expect((await store.read()).tasks[0]?.expiresAt).toBe(monthDeadline(now));
	await store.apply(
		{ ...input, userId: 1, messageId: 4, text: "cancela" },
		cancellation,
	);
	expect((await store.read()).tasks[0]?.status).toBe("cancelled");
});

test("standing sources survive inactivity and match topics for other participants without leaking chats", async () => {
	const text =
		"Cuando investigues pelota, busca en bengaleses.com y pelotainvernal.com";
	await store.apply(
		{ ...input, text },
		plan([
			{
				type: "prefer",
				evidence: text,
				preference: {
					kind: "sources",
					instruction: text,
					topics: ["pelota", "béisbol", "LIDOM"],
					domains: ["bengaleses.com", "pelotainvernal.com"],
				},
			},
		]),
	);
	now += 400 * 86400000;
	const preferences = await new CommitmentStore(store.path).preferences(-99);
	expect(
		matchingPreferences(preferences, "resultados béisbol dominicano"),
	).toHaveLength(1);
	expect(matchingPreferences(preferences, "clima mañana")).toHaveLength(0);
	expect(await store.preferences(-100)).toHaveLength(0);
});

test("corrupt or future stores fail closed without replacement", async () => {
	for (const text of [
		"broken",
		JSON.stringify({ schemaVersion: 99, data: {} }),
	]) {
		await writeFile(store.path, text);
		await expect(store.apply(input, plan([action()]))).rejects.toThrow(
			"original preserved",
		);
		expect(await readFile(store.path, "utf8")).toBe(text);
	}
});

test("voice web sources require written links, a yes is not confirmation, then clarification saves", async () => {
	const services = {
		store,
		now: () => now,
		interpret: async () => plan([action()]),
	};
	const first = await handleCommitmentRequest(
		{ ...input, voice: true },
		services,
	);
	expect(first).toContain("Nothing saved");
	expect((await store.read()).tasks).toHaveLength(0);
	const yes = await handleCommitmentRequest(
		{ ...input, text: "sí", messageId: 2 },
		services,
	);
	expect(yes).toContain("Nothing saved");
	expect((await store.read()).tasks).toHaveLength(0);
	const written = await handleCommitmentRequest(
		{ ...input, text: "https://bengaleses.com", messageId: 3 },
		services,
	);
	expect(written).toContain("saved successfully");
	expect((await store.read()).tasks).toHaveLength(1);
	expect((await store.read()).pending).toHaveLength(0);
});

test("ambiguous requests never mutate; ordinary chat is interpreted without mutating", async () => {
	let calls = 0;
	const services = {
		store,
		now: () => now,
		interpret: async (request: RequestIdentity) => {
			calls++;
			if (request.text === "Hola, qué tal") return plan([]);
			return plan([], {
				clarification: "¿A las siete de la mañana o de la noche?",
			});
		},
	};
	expect(
		await handleCommitmentRequest(
			{ ...input, text: "Hola, qué tal" },
			services,
		),
	).toContain("does not request a task change");
	expect(calls).toBe(1);
	expect(await handleCommitmentRequest(input, services)).toContain(
		"Nothing saved",
	);
	expect((await store.read()).tasks).toHaveLength(0);
});

test("a one-time reminder beyond a month has one finite occurrence and cannot renew", async () => {
	const once = action();
	once.task.schedule = {
		frequency: "once",
		time: "10:00",
		startDate: "2027-01-20",
		weekdays: [0, 1, 2, 3, 4, 5, 6],
	};
	await store.apply(input, plan([once]));
	const task = (await store.read()).tasks[0];
	expect(task?.nextRunAt).toBe(localTime("2027-01-20", "10:00"));
	expect(task?.expiresAt).toBe(localTime("2027-01-20", "11:00"));
	await expect(
		store.apply(
			{ ...input, text: "renueva", messageId: 2 },
			plan([{ type: "renew", ids: [task?.id], evidence: "renueva" }]),
		),
	).rejects.toThrow("recurrentes");
});

test("editing a schedule preserves validated sources without making the user repeat links", async () => {
	await store.apply(input, plan([action()]));
	const old = (await store.read()).tasks[0];
	const edit = {
		...action("08:00"),
		replaceId: old?.id,
		evidence: "cámbialo a las 8am",
	};
	await store.apply(
		{ ...input, text: "cámbialo a las 8am", messageId: 2 },
		plan([edit]),
	);
	const tasks = (await store.read()).tasks;
	expect(tasks[0]?.status).toBe("cancelled");
	expect(tasks[1]?.domains).toEqual(["bengaleses.com"]);
	expect(tasks[1]?.schedule.time).toBe("08:00");
});

const screenshotRequest =
	"DemoBot. Aparte de la página oficial de LIDOM, ¿puedes tener en cuenta lo que dijo Ejemplo? pelotainvernal.com y https://bengaleses.com. Todos los días a las 7 AM darnos el estado del juego?";

test("written bare domains are accepted and the screenshot request bypasses page expansion", async () => {
	expect(writtenDomains(screenshotRequest)).toEqual([
		"pelotainvernal.com",
		"bengaleses.com",
	]);
	const scheduled = action();
	scheduled.evidence = screenshotRequest;
	scheduled.task.domains = ["pelotainvernal.com", "bengaleses.com"];
	let calls = 0;
	const result = await handleCommitmentRequest(
		{ ...input, text: screenshotRequest },
		{
			store,
			now: () => now,
			interpret: async (_input, context) => {
				calls++;
				expect(context).toContain("pelotainvernal.com");
				// The extractor must get one opportunity to correct a mistaken flag.
				return plan([scheduled], { needsWrittenConfirmation: true });
			},
		},
	);
	expect(calls).toBe(2);
	expect(result).toContain("saved successfully");
	expect((await store.read()).tasks[0]?.domains).toEqual(
		scheduled.task.domains,
	);
});

test("a failed interpretation retains typed links and a short follow-up can finish after restart", async () => {
	const first = await handleCommitmentRequest(input, {
		store,
		now: () => now,
		interpret: async () => {
			throw new SyntaxError("invalid JSON");
		},
	});
	expect(first).toContain("retained");
	expect((await store.read()).pending[0]?.writtenText).toBe(input.text);
	const reloaded = new CommitmentStore(store.path, () => now);
	const result = await handleCommitmentRequest(
		{ ...input, messageId: 2, text: "Están pegadas en el texto las URL" },
		{
			store: reloaded,
			now: () => now,
			interpret: async (request, context) => {
				expect(request.text).toContain(input.text);
				expect(JSON.parse(context).writtenDomains).toContain("bengaleses.com");
				return plan([action()]);
			},
		},
	);
	expect(result).toContain("saved successfully");
	expect((await reloaded.read()).tasks).toHaveLength(1);
});

test("typed sources survive another clarification and need not be repeated with the answer", async () => {
	await handleCommitmentRequest(input, {
		store,
		now: () => now,
		interpret: async () => plan([], { clarification: "¿Solo LIDOM?" }),
	});
	const result = await handleCommitmentRequest(
		{ ...input, text: "Sí, solo LIDOM", messageId: 2 },
		{
			store,
			now: () => now,
			interpret: async () => plan([action()]),
		},
	);
	expect(result).toContain("saved successfully");
	expect((await store.read()).tasks[0]?.domains).toEqual(["bengaleses.com"]);
});

test("voice sources can be written in separate messages without losing either link", async () => {
	const scheduled = action();
	scheduled.task.domains = ["bengaleses.com", "pelotainvernal.com"];
	const services = {
		store,
		now: () => now,
		interpret: async () => plan([scheduled]),
	};
	await handleCommitmentRequest({ ...input, voice: true }, services);
	await handleCommitmentRequest(
		{ ...input, text: "bengaleses.com", messageId: 2 },
		services,
	);
	expect((await store.read()).tasks).toHaveLength(0);
	const result = await handleCommitmentRequest(
		{ ...input, text: "Y pelotainvernal.com", messageId: 3 },
		services,
	);
	expect(result).toContain("saved successfully");
	expect((await store.read()).tasks[0]?.domains).toEqual(
		scheduled.task.domains,
	);
});

test("failed voice interpretation never upgrades the transcript to written evidence", async () => {
	await handleCommitmentRequest(
		{ ...input, voice: true },
		{
			store,
			now: () => now,
			interpret: async () => {
				throw new SyntaxError("broken");
			},
		},
	);
	expect((await store.read()).pending[0]?.writtenText).toBe("");
	const result = await handleCommitmentRequest(
		{ ...input, text: "Sí, hazlo", messageId: 2 },
		{ store, now: () => now, interpret: async () => plan([action()]) },
	);
	expect(result).toContain("Nothing saved");
	expect((await store.read()).tasks).toHaveLength(0);
});

test("pending details are isolated from other participants and expire", async () => {
	await handleCommitmentRequest(input, {
		store,
		now: () => now,
		interpret: async () => plan([], { clarification: "¿Solo LIDOM?" }),
	});
	let calls = 0;
	const services = {
		store,
		now: () => now,
		interpret: async (request: RequestIdentity, context: string) => {
			calls++;
			expect(request.text).toBe("sí");
			expect(JSON.parse(context).pendingRequest).toBeUndefined();
			return plan([]);
		},
	};
	await handleCommitmentRequest(
		{ ...input, userId: 8, text: "sí", messageId: 2 },
		services,
	);
	expect(calls).toBe(1);
	now += 16 * 60000;
	await handleCommitmentRequest(
		{ ...input, text: "sí", messageId: 3 },
		services,
	);
	expect(calls).toBe(2);
	expect((await store.read()).tasks).toHaveLength(0);
});

test("a report correction persists in place across reloads and a later deletion stops it", async () => {
	await store.apply(input, plan([action()]));
	const before = (await store.read()).tasks[0];
	if (!before) throw new Error("Missing fixture");
	const correction =
		"En tu reporte puedes omitir las fuentes consultadas, solo danos los datos relevantes";
	const instruction = `${before.instruction}. Consulta las fuentes guardadas pero omite nombres, enlaces y comentarios sobre la búsqueda.`;

	const result = await handleCommitmentRequest(
		{ ...input, messageId: 2, text: correction },
		{
			store,
			now: () => now,
			interpret: async () =>
				plan([
					{ type: "update", id: before.id, instruction, evidence: correction },
				]),
		},
	);
	expect(result).toContain("saved successfully");
	const reloaded = new CommitmentStore(store.path, () => now);
	const after = (await reloaded.read()).tasks[0];
	if (!after) throw new Error("Missing fixture");
	expect(after).toMatchObject({
		id: before.id,
		instruction,
		schedule: before.schedule,
		domains: before.domains,
		searchQuery: before.searchQuery,
		expiresAt: before.expiresAt,
		nextRunAt: before.nextRunAt,
		creatorId: before.creatorId,
	});
	expect((await reloaded.read()).tasks).toHaveLength(1);
	await reloaded.apply(
		{ ...input, messageId: 3, text: "Elimina el reporte diario" },
		plan([
			{
				type: "cancel",
				ids: [before.id],
				evidence: "Elimina el reporte diario",
			},
		]),
	);
	expect((await store.read()).tasks[0]?.status).toBe("cancelled");
});

test("shared task management is opt-in, scoped to the allowed group and excludes personal preferences", async () => {
	const previous = process.env.ALLOW_GROUP_TASK_EDITS;
	try {
		delete process.env.ALLOW_GROUP_TASK_EDITS;
		await store.apply(input, plan([action()]));
		const task = (await store.read()).tasks[0];
		if (!task) throw new Error("Missing fixture");
		const request = {
			...input,
			userId: 8,
			messageId: 2,
			text: "Omite enlaces en el reporte",
		};
		const update = plan([
			{
				type: "update",
				id: task.id,
				instruction: `${task.instruction}. Omite enlaces.`,
				evidence: request.text,
			},
		]);
		await expect(store.apply(request, update)).rejects.toThrow("propias");
		process.env.ALLOW_GROUP_TASK_EDITS = "true";
		await expect(
			store.apply({ ...request, chatId: -100 }, update),
		).rejects.toThrow();
		await store.apply(request, update);
		expect((await store.read()).tasks[0]?.instruction).toContain(
			"Omite enlaces",
		);
		await store.apply(
			{ ...input, messageId: 3, text: "Prefiero respuestas breves" },
			plan([
				{
					type: "prefer",
					evidence: "Prefiero respuestas breves",
					preference: {
						kind: "style",
						instruction: "Respuestas breves",
						topics: ["general"],
					},
				},
			]),
		);
		const pref = (await store.read()).preferences[0];
		if (!pref) throw new Error("Missing fixture");
		await expect(
			store.apply(
				{ ...request, messageId: 4, text: "borra" },
				plan([{ type: "cancel", ids: [pref.id], evidence: "borra" }]),
			),
		).rejects.toThrow("propias");
		await store.apply(
			{ ...request, messageId: 5, text: "borra" },
			plan([{ type: "cancel", ids: [task.id], evidence: "borra" }]),
		);
		expect((await store.read()).tasks[0]?.status).toBe("cancelled");
	} finally {
		if (previous === undefined) delete process.env.ALLOW_GROUP_TASK_EDITS;
		else process.env.ALLOW_GROUP_TASK_EDITS = previous;
	}
});

test("content edits reject expired tasks and unverified evidence without writing", async () => {
	await store.apply(input, plan([action()]));
	const task = (await store.read()).tasks[0];
	if (!task) throw new Error("Missing fixture");
	const before = await readFile(store.path, "utf8");
	await expect(
		store.apply(
			{ ...input, messageId: 2 },
			plan([
				{
					type: "update",
					id: task.id,
					instruction: "Otra cosa",
					evidence: "invented",
				},
			]),
		),
	).rejects.toThrow();
	now = task.expiresAt + 1;
	await expect(
		store.apply(
			{ ...input, messageId: 3 },
			plan([
				{
					type: "update",
					id: task.id,
					instruction: "Otra cosa",
					evidence: input.text,
				},
			]),
		),
	).rejects.toThrow("activa");
	expect(await readFile(store.path, "utf8")).toBe(before);
});

test("extension conversation keeps the draft across restart and adds a day to the existing deadline", async () => {
	await store.apply(input, plan([action()]));
	const original = (await store.read()).tasks[0];
	if (!original) throw new Error("Missing fixture");
	now = localTime("2026-10-24", "08:44");
	const opening = "Perfecto. ¿Podemos probar extenderla ahora?";

	const first = await handleCommitmentRequest(
		{ ...input, messageId: 2, text: opening },
		{
			store,
			now: () => now,
			interpret: async () =>
				plan([], {
					clarification: "¿Cuántos días más quieres añadir al reporte?",
				}),
		},
	);
	expect(first).toContain("Nothing saved");
	expect((await store.read()).pending[0]?.text).toBe(opening);
	const reloaded = new CommitmentStore(store.path, () => now);
	const followup = "Digamos 1 día más";
	const second = await handleCommitmentRequest(
		{ ...input, messageId: 3, text: followup },
		{
			store: reloaded,
			now: () => now,
			interpret: async (request, context) => {
				expect(request.text).toContain(opening);
				expect(request.text).toContain(followup);
				expect(JSON.parse(context).pendingRequest).toBe(opening);
				return plan([
					{ type: "extend", ids: [original.id], days: 1, evidence: followup },
				]);
			},
		},
	);
	expect(second).toContain("saved successfully");
	expect((await reloaded.read()).tasks[0]?.expiresAt).toBe(
		localTime("2026-11-23", "21:02"),
	);
	expect((await reloaded.read()).pending).toHaveLength(0);
	const after = await readFile(store.path, "utf8");
	await reloaded.apply(
		{ ...input, messageId: 3, text: followup },
		plan([{ type: "extend", ids: [original.id], days: 1, evidence: followup }]),
	);
	expect(await readFile(store.path, "utf8")).toBe(after);
});

test("extensions respect the rolling month cap and cannot revive cancelled or expired tasks", async () => {
	await store.apply(input, plan([action()]));
	const original = (await store.read()).tasks[0];
	if (!original) throw new Error("Missing fixture");
	const extend = plan([
		{ type: "extend", ids: [original.id], days: 1, evidence: "un día más" },
	]);
	const before = await readFile(store.path, "utf8");
	await expect(
		store.apply({ ...input, messageId: 2, text: "un día más" }, extend),
	).rejects.toThrow("mes calendario");
	expect(await readFile(store.path, "utf8")).toBe(before);
	now = original.expiresAt + 1;
	await expect(
		store.apply({ ...input, messageId: 2, text: "un día más" }, extend),
	).rejects.toThrow("venció");
});

test("withdrawing a clarification clears only that user's draft, not the task", async () => {
	await store.apply(input, plan([action()]));
	await handleCommitmentRequest(
		{ ...input, messageId: 2, text: "¿Podemos extenderla?" },
		{
			store,
			now: () => now,
			interpret: async () => plan([], { clarification: "¿Cuántos días?" }),
		},
	);
	const before = (await store.read()).tasks;
	const result = await handleCommitmentRequest(
		{ ...input, messageId: 3, text: "Deja seguir trabajando" },
		{
			store,
			now: () => now,
			interpret: async () => plan([], { discardPending: true }),
		},
	);
	expect(result).toContain("withdrawn");
	expect((await store.read()).pending).toHaveLength(0);
	expect((await store.read()).tasks).toEqual(before);
	let called = false;
	await handleCommitmentRequest(
		{ ...input, messageId: 4, text: "1 día más" },
		{
			store,
			now: () => now,
			interpret: async () => {
				called = true;
				return plan([]);
			},
		},
	);
	expect(called).toBe(true);
});

test("Juan's request reaches interpretation without trigger words and confirmation does not duplicate tasks", async () => {
	await store.apply(input, plan([action()]));
	const before = (await store.read()).tasks[0];
	if (!before) throw new Error("Missing fixture");
	const previous = process.env.ALLOW_GROUP_TASK_EDITS;
	process.env.ALLOW_GROUP_TASK_EDITS = "true";
	try {
		const text =
			"Incluye las posibilidades de lluvia a la hora de los juegos en el reporte de las 7am";
		let calls = 0;
		const services = {
			store,
			now: () => now,
			interpret: async (request: RequestIdentity, context: string) => {
				calls++;
				if (request.text === text) {
					expect(JSON.parse(context).sharedTaskManagement).toBe(true);
					return plan([
						{
							type: "update",
							id: before.id,
							instruction:
								before.instruction +
								". Incluye probabilidades de lluvia por ciudad y hora de cada juego.",
							evidence: text,
						},
					]);
				}
				expect(JSON.parse(context).recentConversation[0].text).toBe(text);
				return plan([], { list: true });
			},
		};
		const result = await handleCommitmentRequest(
			{ ...input, userId: 8, messageId: 2, text },
			services,
		);
		expect(result).toContain("saved successfully");
		const after = (await store.read()).tasks[0];
		expect(after?.instruction).toContain("lluvia");
		expect(after?.expiresAt).toBe(before.expiresAt);
		expect(after?.schedule).toEqual(before.schedule);
		await handleCommitmentRequest(
			{
				...input,
				userId: 8,
				messageId: 3,
				text: "Sí, a eso me refería.",
				recentConversation: [{ role: "user", userId: 8, text }],
			},
			services,
		);
		expect(calls).toBe(2);
		expect((await store.read()).tasks).toHaveLength(1);
		expect((await store.read()).tasks[0]).toEqual(after);
	} finally {
		if (previous === undefined) delete process.env.ALLOW_GROUP_TASK_EDITS;
		else process.env.ALLOW_GROUP_TASK_EDITS = previous;
	}
});
