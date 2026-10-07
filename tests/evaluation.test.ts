import { afterEach, expect, spyOn, test } from "bun:test";
import * as core from "../src/ai/core.ts";
import {
	ExtractionParseError,
	evaluateConversationChunk,
	extractFollowUps,
	generateLongTermMemoryUpdate,
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

test("extraction includes saved facts and keeps model provenance with fenced JSON", async () => {
	background.mockResolvedValue({
		text: `\`\`\`json\n${JSON.stringify(extraction)}\n\`\`\``,
		model: "cheap-model",
	});
	const result = await evaluateConversationChunk(
		"Ana: Starting a job",
		"id=old: Ana is a teacher",
	);
	expect(result).toMatchObject({
		...extraction,
		extraction: { model: "cheap-model", droppedFacts: 0 },
	});
	expect(background.mock.calls[0]?.[1][0]?.content).toContain(
		"id=old: Ana is a teacher",
	);
	expect(background.mock.calls[0]?.[2]).toBe("extraction");
});

for (const raw of [
	"not JSON",
	"{broken}",
	JSON.stringify({ ...extraction, importance: 0 }),
	JSON.stringify({ ...extraction, summary: " " }),
]) {
	test(`unusable extraction fails closed: ${raw}`, async () => {
		background.mockResolvedValue({ text: raw, model: "model-a" });
		try {
			await evaluateConversationChunk("Hello");
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtractionParseError);
			expect((error as ExtractionParseError).model).toBe("model-a");
			expect((error as ExtractionParseError).snippet).toBe(raw);
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
					{ trait: " humor ", delta: 0.4, reason: " jokes " },
					{ trait: "made-up", delta: 0.1, reason: "bad" },
					{ trait: "warmth", delta: 0.001, reason: "tiny" },
					{ trait: "energy", delta: -0.4, reason: " tired " },
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
		{ trait: "humor", delta: 0.15, reason: "jokes" },
		{ trait: "energy", delta: -0.15, reason: "tired" },
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

test("follow-up extraction skips casual messages without a model call", async () => {
	expect(await extractFollowUps("Hello", "2026-10-06", "Hello")).toEqual([]);
	expect(plain).not.toHaveBeenCalled();
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
				plan,
				{ ...plan, when: "invalid" },
				{ ...plan, followUpDelayHours: -1 },
			],
		}),
	);
	expect(
		await extractFollowUps(
			"Tomorrow doctor",
			"2026-10-06",
			"Mañana voy a visitar al doctor",
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
test("summary preserves previous episode context", async () => {
	chat.mockResolvedValue("Summary");
	expect(
		await summarizeConversation("New conversation", ["Prior episode"]),
	).toBe("Summary");
	expect(chat.mock.calls[0]?.[1][0]?.content).toContain("Prior episode");
	await summarizeConversation("Only conversation");
	expect(chat.mock.calls[1]?.[1][0]?.content).not.toContain("Previous episode");
});
