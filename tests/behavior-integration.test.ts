import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateScheduledDelivery,
	scheduledGenerationServices,
} from "../src/commitments/runner.ts";
import { behaviorSchema, taskSchema } from "../src/commitments/schema.ts";
import { CommitmentStore } from "../src/commitments/store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
const now = Date.parse("2026-11-08T10:30:00Z");
const task = taskSchema.parse({
	id: "example-task",
	chatId: -99,
	creatorId: 7,
	creatorName: "Ejemplo",
	createdAt: now - 86400000,
	updatedAt: now - 86400000,
	sourceMessageId: 1,
	evidence: "Reporte diario",
	instruction: "Resultados y clasificación",
	kind: "research",
	searchQuery: "liga resultados",
	domains: [],
	schedule: {
		frequency: "daily",
		time: "06:30",
		startDate: "2026-11-07",
		weekdays: [0, 1, 2, 3, 4, 5, 6],
	},
	timezone: "America/Santo_Domingo",
	expiresAt: now + 86400000,
	status: "active",
	lastMessage: "Unverified previous bot promise and old scores",
	behaviors: [
		behaviorSchema.parse({
			id: "example-behavior",
			createdAt: now - 86400000,
			condition: "Equipo Azul gana un partido final",
			instruction: "Enviar un meme",
			output: "image",
		}),
	],
});

test("conditional observations include initial research and chained tool results, excluding drafts and memory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "behavior-evidence-"));
	roots.push(directory);
	const store = new CommitmentStore(join(directory, "state.json"));
	let calls = 0;
	const result = await generateScheduledDelivery(task, {
		...scheduledGenerationServices,
		store,
		now: () => now,
		planImage: async () => null,
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "Persona and private memory are not trigger evidence",
		review: async () => undefined,
		web: {
			isEnabled: () => true,
			context: async () => "Cached stale page",
			refreshHeadlines: async () => {},
			search: async () => "Initial result: standings, game not final yet",
			read: async () => "November 7: Equipo Azul won 5-2. Final.",
		},
		weather: {
			isEnabled: () => false,
			instructions: () => "",
			lookup: async () => "",
		},
		generate: async (_system, messages) => {
			calls++;
			expect(messages[0]?.content).toContain("conditionalChecks");
			if (calls === 1)
				return '[WEB_READ]{"urls":["https://example.com/result"],"notice":"Reviso"}[/WEB_READ]';
			return "Report draft can contain invented claims; never use it as trigger evidence.";
		},
	});
	expect(result.observation?.evidence).toHaveLength(2);
	const evidence = result.observation?.evidence.join("\n") ?? "";
	expect(evidence).toContain("Initial result");
	expect(evidence).toContain("Azul won 5-2");
	expect(evidence).not.toContain("invented claims");
	expect(evidence).not.toContain("old scores");
	expect(evidence).not.toContain("private memory");
	expect(evidence).not.toContain("Cached stale");
});

test("headless binary entry point configures behaviors without starting Telegram or changing the report", async () => {
	const root = await mkdtemp(join(tmpdir(), "behavior-headless-"));
	roots.push(root);
	const store = new CommitmentStore(join(root, "commitments.json"));
	const active = {
		...task,
		expiresAt: Date.now() + 86400000,
		behaviors: undefined,
	};
	await store.transaction((state) => {
		state.tasks.push(active);
	});
	const file = join(root, "config.json");
	await Bun.write(
		file,
		JSON.stringify({
			taskId: task.id,
			behaviors: [
				{
					condition: "Una nueva versión está publicada",
					instruction: "Enviar una felicitación",
					output: "text",
				},
			],
		}),
	);
	const proc = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "../index.ts"),
			"--configure-task-behaviors",
			file,
		],
		{
			cwd: root,
			env: { MEMORY_DIR: root, PATH: process.env.PATH },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => proc.kill(), 5000);
	try {
		const [output, errors, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect({ code, errors }).toEqual({ code: 0, errors: "" });
		expect(output).toContain("behaviors saved");
		const saved = (await store.read()).tasks[0];
		expect(saved?.behaviors?.[0]?.condition).toContain("versión");
		expect(saved?.schedule).toEqual(active.schedule);
		expect(saved?.expiresAt).toBe(active.expiresAt);
		expect(saved?.instruction).toBe(active.instruction);
		expect((await store.read()).receipts).toEqual([]);
	} finally {
		clearTimeout(timer);
		proc.kill();
	}
});
