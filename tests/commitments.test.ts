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
	hasCommitmentIntent,
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
	userName: "Wispe",
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

test("Wispe's two times are persisted atomically, finite, source-complete and idempotent", async () => {
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

test("ambiguous requests never mutate; ordinary chat avoids classifier calls", async () => {
	let calls = 0;
	const services = {
		store,
		now: () => now,
		interpret: async () => {
			calls++;
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
	).not.toContain("COMMITMENT RESULT");
	expect(calls).toBe(0);
	expect(await handleCommitmentRequest(input, services)).toContain(
		"Nothing saved",
	);
	expect((await store.read()).tasks).toHaveLength(0);
	expect(hasCommitmentIntent("Recuérdame mañana a las 7")).toBe(true);
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
