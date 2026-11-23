import { afterEach, expect, spyOn, test } from "bun:test";
import * as core from "../src/ai/core.ts";
import {
	ExtractionParseError,
	evaluateConversationChunk,
	extractFollowUps,
	generateLongTermMemoryUpdate,
	matchFollowUpTopics,
	reviewFactCluster,
	summarizeConversation,
	validatePromotionResult,
} from "../src/ai/evaluation.ts";
import type { Episode, PromotionResult } from "../src/types.ts";

const background = spyOn(core, "generateBackgroundResponseWithModel");
const plain = spyOn(core, "generateBackgroundResponse");
const chat = spyOn(core, "generateResponse");
afterEach(() => {
	background.mockReset();
	plain.mockReset();
	chat.mockReset();
});

// Restore exports when this file finishes so later integration tests use real code.
import { afterAll } from "bun:test";

afterAll(() => {
	background.mockRestore();
	plain.mockRestore();
	chat.mockRestore();
});
const extraction = { summary: "Discussed work", importance: 3, facts: [] };
const narrative = {
	relationship: {
		summary: "Shared career plans",
		tone: "warm",
		notableDynamics: ["mutual trust"],
		openThreads: ["new job"],
	},
	chapter: { title: "Career change", summary: "Starting a job", importance: 4 },
};
const episode: Episode = {
	id: "e1",
	summary: "Starting a job",
	participants: ["Ana"],
	timestamp: Date.now(),
	importance: 4,
	embedding: [],
};

test("extraction shortens saved references and resolves only references in the request", async () => {
	const jobId = `fact_${"a9".repeat(32)}_0`;
	const hobbyId = `fact_${"b7".repeat(32)}_1`;
	const recent = "Ana: I now work as a nurse. I still enjoy pottery.";
	const replacement = {
		content: "Ana works as a nurse",
		category: "person",
		subject: "Ana",
		importance: 3,
	};
	background.mockResolvedValue({
		text:
			"```json\n" +
			JSON.stringify({
				...extraction,
				facts: [{ ...replacement, supersedes: ["F1", "F99", jobId] }],
				confirmedFacts: [
					{ id: "F2", evidence: "I still enjoy pottery" },
					{ id: "F99", evidence: "I still enjoy pottery" },
				],
			}) +
			"\n```",
		model: "cheap-model",
	});
	const result = await evaluateConversationChunk(recent, [
		{
			id: jobId,
			category: "person",
			subject: "Ana",
			content: "Ana is a teacher",
		},
		{
			id: hobbyId,
			category: "person",
			subject: "Ana",
			content: "Ana enjoys pottery",
		},
	]);
	expect(result.facts[0]).toMatchObject({
		...replacement,
		supersedes: [jobId],
	});
	expect(result.confirmedFacts).toEqual([
		{ id: hobbyId, evidence: "I still enjoy pottery" },
	]);
	expect(result.extraction).toEqual({ model: "cheap-model", droppedFacts: 0 });
	expect(background.mock.calls).toHaveLength(1);
	expect(background.mock.calls[0]?.[2]).toBe("extraction");
	const prompt = background.mock.calls[0]?.[1][0]?.content ?? "";
	const shortFacts =
		"- (F1) [Ana] Ana is a teacher\n- (F2) [Ana] Ana enjoys pottery";
	const fullFacts = `- (${jobId}) [Ana] Ana is a teacher\n- (${hobbyId}) [Ana] Ana enjoys pottery`;
	expect(prompt).toContain(shortFacts);
	expect(prompt).toContain(recent);
	expect(prompt).not.toContain(jobId);
	expect(prompt).not.toContain(hobbyId);
	expect(prompt.length).toBeLessThan(
		prompt.replace(shortFacts, fullFacts).length - 100,
	);
});

test("short confirmation evidence is dropped without losing the episode or valid facts", async () => {
	const newFact = {
		content: "Ana works as a nurse",
		category: "person",
		subject: "Ana",
	};
	const savedFact = {
		id: "saved-pottery-fact",
		content: "Ana enjoys pottery",
		category: "person",
		subject: "Ana",
	} as const;
	background.mockResolvedValue({
		text: JSON.stringify({
			...extraction,
			facts: [newFact],
			confirmedFacts: [
				{ id: "F1", evidence: "   Yes   " },
				null,
				{ id: "F1", evidence: "I still enjoy pottery" },
			],
		}),
		model: "cheap-model",
	});
	const result = await evaluateConversationChunk(
		"Ana: Yes. I still enjoy pottery. I now work as a nurse.",
		[savedFact],
	);
	expect(result).toMatchObject({
		summary: extraction.summary,
		importance: extraction.importance,
		facts: [newFact],
	});
	expect(result.confirmedFacts).toEqual([
		{ id: savedFact.id, evidence: "I still enjoy pottery" },
	]);
});

for (const [raw, diagnostic] of [
	["not JSON", { reason: "missing_object" }],
	["{broken}", { reason: "invalid_json" }],
	[
		JSON.stringify({ ...extraction, importance: 0 }),
		{ reason: "invalid_schema", field: "importance" },
	],
	[
		JSON.stringify({ ...extraction, summary: " " }),
		{ reason: "invalid_schema", field: "summary" },
	],
	[
		JSON.stringify({ ...extraction, confirmedFacts: {} }),
		{ reason: "invalid_schema", field: "confirmedFacts" },
	],
] as const) {
	test(`unusable extraction fails closed: ${raw}`, async () => {
		background.mockResolvedValue({ text: raw, model: "model-a" });
		try {
			await evaluateConversationChunk("Hello");
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtractionParseError);
			expect((error as ExtractionParseError).model).toBe("model-a");
			expect((error as ExtractionParseError).diagnostic).toMatchObject({
				...diagnostic,
				outputChars: raw.length,
			});
			expect((error as Error).message).not.toContain(raw);
		}
	});
}

test("malformed optional facts and traits cannot discard a usable episode", () => {
	const result = validatePromotionResult(
		{
			...extraction,
			facts: [
				null,
				42,
				{ content: "bad", category: "person", subject: 4 },
				{
					content: "  Likes tea ",
					category: "person",
					subject: " Ana ",
					context: 4,
					importance: Number.NaN,
					permanent: "true",
					supersedes: [" old ", 42, ""],
				},
			],
			personalitySignals: {
				traitChanges: [
					null,
					{ trait: "Warmth", delta: Number.POSITIVE_INFINITY, reason: "trust" },
					{
						trait: " humor ",
						delta: 0.4,
						reason: " jokes ",
						directToBot: true,
						evidence: " Keep making those jokes ",
					},
					{ trait: "made-up", delta: 0.1, reason: "bad" },
					{ trait: "warmth", delta: 0.001, reason: "tiny" },
					{
						trait: "energy",
						delta: -0.4,
						reason: " tired ",
						directToBot: true,
						evidence: "Please be less energetic",
					},
					{ trait: "curiosity", delta: 0.1, reason: "no direct evidence" },
				],
			},
		} as unknown as PromotionResult,
		"test",
	);
	expect(result.facts).toEqual([
		{
			content: "Likes tea",
			category: "person",
			subject: "Ana",
			context: undefined,
			importance: 3,
			permanent: false,
			supersedes: ["old"],
		},
	]);
	expect(result.extraction?.droppedFacts).toBe(3);
	expect(result.personalitySignals?.traitChanges).toEqual([
		{
			trait: "humor",
			delta: 0.15,
			reason: "jokes",
			directToBot: true,
			evidence: "Keep making those jokes",
		},
		{
			trait: "energy",
			delta: -0.15,
			reason: "tired",
			directToBot: true,
			evidence: "Please be less energetic",
		},
	]);
});

test("facts normalize importance and reject empty content, category and subject", () => {
	const result = validatePromotionResult({
		...extraction,
		facts: [
			{ content: " ", category: "rule" },
			{ content: "wrong", category: "world" },
			{ content: "missing subject", category: "person" },
			{ content: "boundary", category: "rule", importance: 99 },
			{ content: "group", category: "group", importance: -3 },
		],
	} as PromotionResult);
	expect(result.facts.map((f) => f.importance)).toEqual([5, 1]);
	expect(result.personalitySignals).toBeUndefined();
});

test("narrative update merges old context and preserves valid output", async () => {
	background.mockResolvedValue({
		text: JSON.stringify(narrative),
		model: "narrator",
	});
	expect(
		await generateLongTermMemoryUpdate({
			existingRelationship: null,
			existingChapter: null,
			episode,
			recentMessages: "Ana: new job",
			month: "2026-10",
		}),
	).toEqual(narrative);
	expect(background.mock.calls[0]?.[2]).toBe("narrative");
	const existingRelationship = {
		...narrative.relationship,
		chatId: 123,
		interactionCount: 2,
		updatedAt: Date.now(),
	};
	const existingChapter = {
		...narrative.chapter,
		id: "ch",
		chatId: 123,
		month: "2026-10",
		episodeIds: [],
		participants: ["Ana"],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	await generateLongTermMemoryUpdate({
		existingRelationship,
		existingChapter,
		episode,
		recentMessages: "Update",
		month: "2026-10",
	});
	expect(background.mock.calls[1]?.[1][0]?.content).toContain("mutual trust");
	expect(background.mock.calls[1]?.[1][0]?.content).toContain("Career change");
});

for (const raw of [
	"no JSON",
	"{bad}",
	JSON.stringify({
		...narrative,
		chapter: { ...narrative.chapter, importance: 6 },
	}),
]) {
	test(`invalid narrative throws instead of overwriting memory: ${raw}`, async () => {
		background.mockResolvedValue({ text: raw, model: "narrator" });
		await expect(
			generateLongTermMemoryUpdate({
				existingRelationship: null,
				existingChapter: null,
				episode,
				recentMessages: "Hello",
				month: "2026-10",
			}),
		).rejects.toBeInstanceOf(ExtractionParseError);
	});
}

test("janitor trims retirements and ignores malformed entries", async () => {
	plain.mockResolvedValue(
		JSON.stringify({
			retire: [
				null,
				{ id: " " },
				{ id: " old ", supersededBy: " new ", reason: " obsolete " },
				{ id: "duplicate", reason: 42 },
			],
		}),
	);
	expect(
		await reviewFactCluster({
			subject: "Ana",
			facts: [{ id: "old", content: "Teacher", createdAt: 0, importance: 3 }],
		}),
	).toEqual([
		{ id: "old", supersededBy: "new", reason: "obsolete" },
		{ id: "duplicate", supersededBy: undefined, reason: "" },
	]);
	expect(plain.mock.calls[0]?.[2]).toBe("janitor");
});
for (const raw of ["not JSON", "{bad}", "{}", '{"retire":null}']) {
	test(`invalid janitor response is retriable: ${raw}`, async () => {
		plain.mockResolvedValue(raw);
		await expect(
			reviewFactCluster({ subject: "Ana", facts: [] }),
		).rejects.toBeInstanceOf(ExtractionParseError);
	});
}

test("follow-up extraction sends ordinary and indirect wording to the model", async () => {
	plain.mockResolvedValue('{"followUps":[]}');
	expect(await extractFollowUps("Hello", "2026-10-06", "Hello")).toEqual([]);
	expect(plain).toHaveBeenCalledTimes(1);
	expect(plain.mock.calls[0]?.[1][0]?.content).toContain(
		'"latestMessage":"Hello"',
	);
});
test("follow-up extraction keeps valid plans beside malformed candidates", async () => {
	const plan = {
		event: "doctor",
		when: "2026-10-07T14:00:00Z",
		followUpDelayHours: 2,
		question: "How was it?",
	};
	plain.mockResolvedValue(
		JSON.stringify({
			followUps: [
				null,
				{ ...plan, evidence: "Sí, está confirmado" },
				{ ...plan, evidence: "The appointment is tomorrow" },
				{ ...plan, when: "invalid", evidence: "Sí, está confirmado" },
				{ ...plan, followUpDelayHours: -1, evidence: "Sí, está confirmado" },
			],
		}),
	);
	expect(
		await extractFollowUps(
			"The appointment is tomorrow",
			"2026-10-06",
			"Sí, está confirmado",
		),
	).toEqual([plan]);
});
for (const raw of ["not JSON", "{bad}", "{}", '{"followUps":42}']) {
	test(`invalid follow-up output adds no reminders: ${raw}`, async () => {
		plain.mockResolvedValue(raw);
		expect(
			await extractFollowUps("tomorrow", "2026-10-06", "Mañana voy a salir"),
		).toEqual([]);
	});
}
test("follow-up matching accepts a paraphrase and rejects unknown state IDs", async () => {
	const candidates = [{ id: "appointment", event: "Dentist appointment" }];
	plain.mockResolvedValueOnce('{"matchedIds":["appointment"]}');
	plain.mockResolvedValueOnce('{"matchedIds":["other"]}');
	expect(
		await matchFollowUpTopics(
			"resolved",
			"La consulta terminó bien",
			candidates,
		),
	).toEqual(new Set(["appointment"]));
	expect(
		await matchFollowUpTopics(
			"resolved",
			"La consulta terminó bien",
			candidates,
		),
	).toBeNull();
});
test("summary preserves previous episode context", async () => {
	chat.mockResolvedValue("Summary");
	expect(
		await summarizeConversation("New conversation", ["Prior episode"]),
	).toBe("Summary");
	expect(chat.mock.calls[0]?.[1][0]?.content).toContain("Prior episode");
	await summarizeConversation("Only conversation");
	expect(chat.mock.calls[1]?.[1][0]?.content).not.toContain("Previous episode");
});
