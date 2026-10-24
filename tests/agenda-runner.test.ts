import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTime } from "../src/commitments/calendar.ts";
import {
	type RunnerServices,
	runScheduledTasks,
} from "../src/commitments/runner.ts";
import { interpretationSchema } from "../src/commitments/schema.ts";
import { CommitmentStore } from "../src/commitments/store.ts";

let root: string;
let now: number;
let store: CommitmentStore;
let services: RunnerServices;
let delivered: string[];
let alerts: string[];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "agenda-"));
	now = localTime("2026-10-22", "06:00");
	store = new CommitmentStore(join(root, "state.json"), () => now);
	await store.apply(
		{
			chatId: -99,
			userId: 7,
			userName: "Ejemplo",
			messageId: 1,
			text: "todos los días a las 7",
		},
		interpretationSchema.parse({
			actions: [
				{
					type: "schedule",
					evidence: "todos los días a las 7",
					task: {
						instruction: "Resultados de ayer",
						kind: "research",
						searchQuery: "LIDOM resultados ayer",
						schedule: {
							frequency: "daily",
							time: "07:00",
							startDate: "2026-10-22",
							weekdays: [0, 1, 2, 3, 4, 5, 6],
						},
					},
				},
			],
		}),
	);
	delivered = [];
	alerts = [];
	services = {
		store,
		now: () => now,
		generate: async () => "Ya están los resultados de anoche.",
		deliver: async (_chat, text) => {
			delivered.push(text);
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
afterEach(() => rm(root, { recursive: true, force: true }));

test("due delivery happens once across concurrent ticks and restart", async () => {
	now = localTime("2026-10-22", "07:00");
	await Promise.all([runScheduledTasks(services), runScheduledTasks(services)]);
	await runScheduledTasks({
		...services,
		store: new CommitmentStore(store.path, () => now),
	});
	expect(delivered).toHaveLength(1);
	const task = (await store.read()).tasks[0];
	expect(task?.lastOccurrence?.status).toBe("sent");
	expect(task?.nextRunAt).toBe(localTime("2026-10-23", "07:00"));
});

test("outage skips stale runs instead of flooding, expiry prevents any delivery", async () => {
	now = localTime("2026-10-25", "15:00");
	await runScheduledTasks(services);
	expect(delivered).toHaveLength(0);
	expect((await store.read()).tasks[0]?.nextRunAt).toBe(
		localTime("2026-10-26", "07:00"),
	);
	now = localTime("2026-11-25", "07:00");
	await runScheduledTasks(services);
	expect(delivered).toHaveLength(0);
	expect((await store.read()).tasks[0]?.status).toBe("expired");
});

test("off, sleep and revoked access suppress sending; rechecked after generation", async () => {
	now = localTime("2026-10-22", "07:00");
	await runScheduledTasks({ ...services, isOff: () => true });
	await runScheduledTasks({ ...services, isSleeping: () => true });
	await runScheduledTasks({ ...services, isAllowed: () => false });
	expect(delivered).toHaveLength(0);
	let off = false;
	await runScheduledTasks({
		...services,
		isOff: () => off,
		generate: async () => {
			off = true;
			return "Hola";
		},
	});
	expect(delivered).toHaveLength(0);
});

test("cancelling during generation prevents sending", async () => {
	now = localTime("2026-10-22", "07:00");
	await runScheduledTasks({
		...services,
		generate: async (task) => {
			await store.apply(
				{
					chatId: -99,
					userId: 7,
					userName: "Ejemplo",
					messageId: 2,
					text: "cancela",
				},
				interpretationSchema.parse({
					actions: [{ type: "cancel", ids: [task.id], evidence: "cancela" }],
				}),
			);
			return "Hola";
		},
	});
	expect(delivered).toHaveLength(0);
});

test("ambiguous Telegram outcome is recorded and never retried; subsequent occurrence still runs", async () => {
	now = localTime("2026-10-22", "07:00");
	let attempts = 0;
	const fail = {
		...services,
		deliver: async () => {
			attempts++;
			throw new Error("timeout after sending");
		},
	};
	await runScheduledTasks(fail);
	await runScheduledTasks(fail);
	expect(attempts).toBe(1);
	expect((await store.read()).tasks[0]?.lastOccurrence?.status).toBe("unknown");
	expect(alerts).toHaveLength(1);
	now = localTime("2026-10-23", "07:00");
	await runScheduledTasks(services);
	expect(delivered).toHaveLength(1);
});

test("generation failure and post-send history failure cannot cause duplicate delivery", async () => {
	now = localTime("2026-10-22", "07:00");
	await runScheduledTasks({
		...services,
		generate: async () => {
			throw new Error("model down");
		},
	});
	expect(delivered).toHaveLength(0);
	expect(alerts).toHaveLength(1);
	now = localTime("2026-10-23", "07:00");
	await runScheduledTasks({
		...services,
		record: async () => {
			throw new Error("disk");
		},
	});
	await runScheduledTasks(services);
	expect(delivered).toHaveLength(1);
});

test("scheduled research uses fresh public terms and task sources, then renders with personality", async () => {
	const { generateScheduledMessage, scheduledGenerationServices } =
		await import("../src/commitments/runner.ts");
	const { WorldContextService } = await import("../src/world-context.ts");
	const task = (await store.read()).tasks[0];
	if (!task) throw new Error("Expected task");
	task.instruction =
		"Dile a Ejemplo los resultados de ayer, como acordaron en privado";
	task.domains = ["bengaleses.com"];
	const queries: string[] = [];
	const web = new WorldContextService({
		directory: join(root, "web"),
		enabled: () => true,
		now: () => now,
		search: async (request) => {
			queries.push(request.query);
			return [
				{
					title: "Resultados",
					url: "https://bengaleses.com/resultados",
					text: "Verified baseball result",
				},
			];
		},
	});
	const message = await generateScheduledMessage(task, {
		...scheduledGenerationServices,
		store,
		web,
		now: () => now,
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "DemoBot has her own warm Dominican personality.",
		generate: async (system, messages) => {
			expect(system).toContain("warm Dominican personality");
			expect(system).toContain("not a request to create or renew");
			expect(messages[0]?.content).toContain("Verified baseball result");
			return "[TTS]Mira cómo quedó la pelota anoche.[/TTS]";
		},
	});
	expect(message).toBe("Mira cómo quedó la pelota anoche.");
	expect(queries).toHaveLength(2);
	expect(queries[0]).toContain("site:bengaleses.com");
	expect(
		queries.every((q) => !q.includes("Ejemplo") && !q.includes("privado")),
	).toBe(true);
});

test("restart after persisted send intent reports uncertainty without replay", async () => {
	const due = localTime("2026-10-22", "07:00");
	await store.transaction((state) => {
		const task = state.tasks[0];
		if (!task) throw new Error("Missing task");
		task.lastOccurrence = { dueAt: due, claimedAt: due, status: "sending" };
		task.nextRunAt = localTime("2026-10-23", "07:00");
	});
	now = due + 11 * 60000;
	await runScheduledTasks(services);
	await runScheduledTasks(services);
	expect(delivered).toHaveLength(0);
	expect(alerts).toHaveLength(1);
	expect((await store.read()).tasks[0]?.lastOccurrence?.status).toBe("unknown");
});

test("editing during generation discards the old response and next run uses the saved correction", async () => {
	now = localTime("2026-10-22", "07:00");
	await runScheduledTasks({
		...services,
		generate: async (task) => {
			await store.apply(
				{
					chatId: -99,
					userId: 7,
					userName: "Ejemplo",
					messageId: 2,
					text: "Omite fuentes",
				},
				interpretationSchema.parse({
					actions: [
						{
							type: "update",
							id: task.id,
							instruction: "Resultados de ayer sin enlaces",
							evidence: "Omite fuentes",
						},
					],
				}),
			);
			return "Old response with links";
		},
	});
	expect(delivered).toHaveLength(0);
	expect((await store.read()).tasks[0]?.lastOccurrence?.status).toBe("failed");
	now = localTime("2026-10-23", "07:00");
	await runScheduledTasks({
		...services,
		generate: async (task) => {
			expect(task.instruction).toBe("Resultados de ayer sin enlaces");
			return "Updated report";
		},
	});
	expect(delivered).toEqual(["Updated report"]);
});

test("recurring tasks with no remaining occurrences retain their renewal window until expiry", async () => {
	const expiresAt = localTime("2026-11-22", "11:33");
	await store.transaction((state) => {
		const task = state.tasks[0];
		if (!task) throw new Error("Missing task");
		task.nextRunAt = undefined;
		task.expiresAt = expiresAt;
		task.renewalReminderDays = 2;
	});
	now = localTime("2026-11-20", "07:00");
	await runScheduledTasks(services);
	expect((await store.read()).tasks[0]?.status).toBe("active");
	now = expiresAt + 1;
	await runScheduledTasks(services);
	expect((await store.read()).tasks[0]?.status).toBe("expired");
});

test("scheduled research chains three venue forecasts without leaking controls or changing the task", async () => {
	const { generateScheduledMessage, scheduledGenerationServices } =
		await import("../src/commitments/runner.ts");
	const { WorldContextService } = await import("../src/world-context.ts");
	const task = (await store.read()).tasks[0];
	if (!task) throw new Error("Missing task");
	task.instruction =
		"Reporta los juegos y lluvia a la hora de cada juego, sin fuentes.";
	const before = structuredClone(task);
	const cities = ["Santo Domingo", "Santiago", "San Pedro de Macorís"];
	const hours = [16, 18, 19];
	const requests: unknown[] = [];
	let calls = 0;
	const web = new WorldContextService({
		directory: join(root, "weather-web"),
		enabled: () => true,
		now: () => now,
		search: async () => [
			{
				title: "Cartelera",
				url: "https://example.com/fixtures",
				text: "Hoy: Santo Domingo 16:00; Santiago 18:00; San Pedro de Macorís 19:30, zona America/Santo_Domingo.",
			},
		],
	});
	const result = await generateScheduledMessage(task, {
		...scheduledGenerationServices,
		store,
		web,
		now: () => now,
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "Responde en español.",
		weather: {
			isEnabled: () => true,
			instructions: () => "Weather lookup available.",
			lookup: async (request) => {
				requests.push(request);
				return `${request.location}: hora ${request.hour}:00, lluvia 40%; hora ${(request.hour ?? 0) + 1}:00, lluvia 50%.`;
			},
		},
		generate: async (system, messages) => {
			expect(system).toContain("SCHEDULED DELIVERY OVERRIDE");
			if (calls < 3) {
				const i = calls++;
				return `[WEATHER_LOOKUP]${JSON.stringify({ location: cities[i], countryCode: "DO", date: "2026-10-22", hour: hours[i], notice: "Reviso el clima." })}[/WEATHER_LOOKUP]`;
			}
			expect(messages.map((m) => m.content).join("\n")).toContain(
				"San Pedro de Macorís: hora 19:00",
			);
			return "Santo Domingo 16:00: 40%; Santiago 18:00: 40%. San Pedro 19:30: 40% a las 19:00 y 50% a las 20:00. Es pronóstico de lluvia, sin suspensión confirmada.";
		},
	});
	expect(requests).toHaveLength(3);
	expect(result).toContain("19:30");
	expect(result).not.toContain("WEATHER_LOOKUP");
	expect(task).toEqual(before);
});

test("scheduled forecasts reject implicit installation location and recover from unavailable weather", async () => {
	const { generateScheduledMessage, scheduledGenerationServices } =
		await import("../src/commitments/runner.ts");
	const task = (await store.read()).tasks[0];
	if (!task) throw new Error("Missing task");
	let calls = 0;
	let lookups = 0;
	const result = await generateScheduledMessage(task, {
		...scheduledGenerationServices,
		store,
		web: new (await import("../src/world-context.ts")).WorldContextService({
			directory: join(root, "disabled"),
			enabled: () => false,
		}),
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "Español.",
		weather: {
			isEnabled: () => true,
			instructions: () => "Weather tool.",
			lookup: async () => {
				lookups++;
				throw new Error("Forecast unavailable");
			},
		},
		generate: async (_system, messages) => {
			calls++;
			if (calls === 1)
				return '[WEATHER_LOOKUP]{"hour":19,"notice":"Reviso."}[/WEATHER_LOOKUP]';
			if (calls === 2) {
				expect(messages.at(-1)?.content).toContain(
					"explicit verified location",
				);
				return '[WEATHER_LOOKUP]{"location":"Santiago","countryCode":"DO","hour":19,"notice":"Reviso."}[/WEATHER_LOOKUP]';
			}
			return "No pude confirmar el pronóstico para la hora del juego.";
		},
	});
	expect(lookups).toBe(1);
	expect(result).toContain("No pude confirmar");
});

test("personal reminders never invoke research or weather tools", async () => {
	const { generateScheduledMessage, scheduledGenerationServices } =
		await import("../src/commitments/runner.ts");
	const task = (await store.read()).tasks[0];
	if (!task) throw new Error("Missing task");
	task.kind = "reminder";
	let calls = 0;
	const result = await generateScheduledMessage(task, {
		...scheduledGenerationServices,
		store,
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "Español.",
		weather: {
			isEnabled: () => {
				throw new Error("Unexpected weather access");
			},
			instructions: () => "",
			lookup: async () => {
				throw new Error("Unexpected lookup");
			},
		},
		generate: async () => {
			calls++;
			return "Es hora de salir.";
		},
	});
	expect(calls).toBe(1);
	expect(result).toBe("Es hora de salir.");
});
