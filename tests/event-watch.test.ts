import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BehaviorServices,
	runTaskBehaviors,
} from "../src/commitments/behavior-runner.ts";
import {
	eventWatchSchedule,
	localTime,
	MAX_WATCH_CHECKS,
	WATCH_RECHECK_MS,
} from "../src/commitments/calendar.ts";
import {
	type RunnerServices,
	runScheduledTasks,
} from "../src/commitments/runner.ts";
import { interpretationSchema } from "../src/commitments/schema.ts";
import { CommitmentStore } from "../src/commitments/store.ts";

const opening = "Si gana Coral, te toca mandarme una caricatura de Nube.";
const request = {
	chatId: -99,
	userId: 7,
	userName: "Ada",
	messageId: 4,
	text: opening,
};
const plan = interpretationSchema.parse({
	actions: [
		{
			type: "watch_event",
			evidence: opening,
			eventDate: "2026-11-14",
			anchorTime: "17:00",
			waitMinutes: 180,
			searchQuery: "Liga del Faro Coral Nube 14 noviembre resultado final",
			behavior: {
				condition: "Coral gana contra Nube el 14 de noviembre",
				instruction: "Bromea sobre Nube con una caricatura",
				output: "image",
			},
		},
	],
});
let now: number;
let root: string;
let store: CommitmentStore;
let runner: RunnerServices;
let sent: string[];
let outcome: "matched" | "not_matched" | "unknown";
let observations: number;
let sleeping: boolean;
let alerts: string[];
beforeEach(async () => {
	now = localTime("2026-11-14", "09:00");
	root = await mkdtemp(join(tmpdir(), "bot-event-watch-"));
	store = new CommitmentStore(join(root, "commitments.json"), () => now);
	await store.apply(request, plan);
	outcome = "unknown";
	observations = 0;
	sleeping = false;
	sent = [];
	alerts = [];
	const effects: BehaviorServices = {
		store,
		now: () => now,
		isOff: () => false,
		isSleeping: () => sleeping,
		isAllowed: () => true,
		evaluate: async () => ({
			outcome,
			reason: "Synthetic evidence",
			events:
				outcome === "matched"
					? [
							{
								key: "coral-nube-20261114",
								date: "2026-11-14",
								summary: "Coral ganó",
								evidence: [{ index: 0, quote: "Final: Coral 3, Nube 1" }],
							},
						]
					: [],
		}),
		render: async () => ({
			text: "Caricatura de Nube",
			image: Buffer.from("image"),
		}),
		deliver: async (_id, message) => {
			expect(message.image?.length).toBeGreaterThan(0);
			sent.push(message.text);
		},
		alert: async (msg) => {
			alerts.push(msg);
		},
		record: async () => {},
	};
	runner = {
		...effects,
		generate: async () => {
			throw Error("Unexpected report generation");
		},
		deliver: async () => {
			throw Error("Unexpected report delivery");
		},
		observeEvent: async () => {
			observations++;
			return {
				evidence: ["Synthetic evidence"],
				checkedAt: now,
				persona: "Vega",
			};
		},
		behaviors: async (task, observation) =>
			runTaskBehaviors(task, observation, { ...effects, store }),
	};
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("persists the estimated check, waits through extra innings and sends the wager once after restart", async () => {
	await store.apply(request, plan);
	expect((await store.read()).tasks).toHaveLength(1);
	expect((await store.read()).tasks[0]?.nextRunAt).toBe(
		localTime("2026-11-14", "20:00"),
	);
	await runScheduledTasks(runner);
	expect(observations).toBe(0);
	now = localTime("2026-11-14", "20:00");
	await runScheduledTasks(runner);
	expect(sent).toEqual([]);
	store = new CommitmentStore(store.path, () => now);
	runner.store = store;
	expect((await store.read()).tasks[0]?.nextRunAt).toBe(now + WATCH_RECHECK_MS);
	now += WATCH_RECHECK_MS;
	outcome = "matched";
	await Promise.all([runScheduledTasks(runner), runScheduledTasks(runner)]);
	await runScheduledTasks(runner);
	expect(sent).toEqual(["Caricatura de Nube"]);
	expect((await store.read()).tasks[0]).toMatchObject({
		status: "completed",
		checksMade: 2,
	});
	expect(alerts).toEqual([]);
});
test.each(["loss", "cancel", "inconclusive", "uncertain delivery"] as const)(
	"quietly settles or expires a watch after %s",
	async (scenario) => {
		now = localTime("2026-11-14", "20:00");
		const task = (await store.read()).tasks[0];
		if (!task) throw new Error("Missing watch");
		if (scenario === "loss") outcome = "not_matched";
		if (scenario === "cancel")
			await store.apply(
				{ ...request, messageId: 5, text: "Olvida el trato" },
				interpretationSchema.parse({
					actions: [
						{ type: "cancel", ids: [task.id], evidence: "Olvida el trato" },
					],
				}),
			);
		if (scenario === "uncertain delivery")
			await store.transaction((state) => {
				const saved = state.tasks[0];
				const behavior = saved?.behaviors?.[0];
				if (!saved || !behavior) throw new Error("Missing watch behavior");
				saved.behaviorEvents = [
					{
						behaviorId: behavior.id,
						eventKey: "game",
						date: "2026-11-14",
						summary: "final",
						status: "sending",
						attempts: [now],
						updatedAt: now,
					},
				];
			});
		sleeping = true;
		await runScheduledTasks(runner);
		expect(observations).toBe(0);
		sleeping = false;
		now += 90 * 60000;
		for (let i = 0; i <= MAX_WATCH_CHECKS; i++) {
			await runScheduledTasks(runner);
			now += WATCH_RECHECK_MS;
		}
		expect(observations).toBe(
			scenario === "loss"
				? 1
				: scenario === "inconclusive"
					? MAX_WATCH_CHECKS
					: 0,
		);
		expect((await store.read()).tasks[0]?.status).toBe(
			scenario === "cancel"
				? "cancelled"
				: scenario === "inconclusive"
					? "expired"
					: "completed",
		);
		expect(sent).toEqual([]);
		expect(alerts).toEqual([]);
	},
);
test("a late start can cross midnight without changing the fixture date", () => {
	const result = eventWatchSchedule(
		"2026-11-14",
		"22:15",
		180,
		now,
		"America/Santo_Domingo",
	);
	expect(result.schedule).toMatchObject({
		startDate: "2026-11-15",
		time: "01:15",
		weekdays: [0],
	});
});
