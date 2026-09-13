import { beforeEach, expect, spyOn, test } from "bun:test";
import {
	validateLongTermMemoryUpdate,
	validatePromotionResult,
} from "../src/ai/evaluation.ts";
import {
	getRelevantChapters,
	saveChapterStore,
} from "../src/memory/chapters.ts";
import {
	addSemanticFacts,
	confirmSemanticFacts,
	decayConfidence,
	getFactsForSubjects,
	getPermanentFacts,
	getRelevantFacts,
	loadSemanticStore,
	saveSemanticStore,
} from "../src/memory/semantic.ts";
import {
	assembleSystemPrompt,
	fitMemorySection,
	MEMORY_PROMPT_MAX_CHARS,
} from "../src/prompt/assemble.ts";
import { buildPromptContext } from "../src/prompt/context.ts";
import { weatherCurrent } from "../src/prompt/sections/activity.ts";
import type { SemanticFact } from "../src/types.ts";

const day = 86400000;
const now = Date.now();
function fact(id: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id,
		content: "Ana enjoys pottery",
		category: "person",
		subject: "Ana",
		embedding: [1, 0, 0],
		importance: 4,
		confidence: 1,
		createdAt: now - 100 * day,
		lastConfirmed: now - 100 * day,
		...overrides,
	};
}
beforeEach(() => saveSemanticStore([]));

test("old preferences survive decay and can be retrieved selectively as historical context", async () => {
	await saveSemanticStore([fact("old")]);
	await decayConfidence(now + day);
	const stored = (await loadSemanticStore())[0];
	expect(stored?.archivedAt).toBeDefined();
	expect(stored?.confidence).toBe(0);
	expect(await getFactsForSubjects(["Ana"])).toHaveLength(0);
	expect(
		await getRelevantFacts([0, 1, 0], { queryText: "weather forecast" }),
	).toHaveLength(0);
	expect(
		(await getRelevantFacts([1, 0, 0], { queryText: "pottery" }))[0]?.id,
	).toBe("old");
});

test("all permanent facts are stored while prompt selection remains capped and subject-aware", async () => {
	await addSemanticFacts(
		Array.from({ length: 30 }, (_, i) =>
			fact(`p${i}`, { subject: `Person ${i}`, permanent: true, embedding: [] }),
		),
	);
	expect(await loadSemanticStore()).toHaveLength(30);
	const selected = await getPermanentFacts({ subjects: ["Person 29"] });
	expect(selected).toHaveLength(25);
	expect(selected[0]?.id).toBe("p29");
});

test("confirmation revives an archived fact once without rolling back newer evidence", async () => {
	await saveSemanticStore([
		fact("old", { archivedAt: now - day, confidence: 0 }),
	]);
	await confirmSemanticFacts(["old"], "chunk-a", now);
	await confirmSemanticFacts(["old"], "chunk-a", now + day);
	let stored = (await loadSemanticStore())[0];
	expect(stored?.archivedAt).toBeUndefined();
	expect(stored?.lastConfirmed).toBe(now);
	expect(stored?.appliedFactIds).toEqual(["confirmation_chunk-a"]);
	await confirmSemanticFacts(["old"], "chunk-b", now - day);
	stored = (await loadSemanticStore())[0];
	expect(stored?.lastConfirmed).toBe(now);
});

test("retired facts are never revived by delayed confirmation", async () => {
	await saveSemanticStore([
		fact("old", { supersededBy: "new", confidence: 0.1 }),
	]);
	await confirmSemanticFacts(["old"], "chunk", now);
	expect((await loadSemanticStore())[0]?.lastConfirmed).toBe(now - 100 * day);
});

test("chapter retrieval finds an older date or topic while staying within two chapters", async () => {
	const chatId = 918001;
	await saveChapterStore({
		chatId,
		chapters: ["2026-01", "2026-07", "2026-08", "2026-09"].map((month, i) => ({
			id: month,
			chatId,
			month,
			title: i === 0 ? "Pottery exhibition" : "Daily life",
			summary:
				i === 0
					? "Ana exhibited ceramic bowls in Kyoto"
					: "We chatted about everyday routines",
			importance: 3,
			participants: ["Ana"],
			episodeIds: [],
			updatedAt: now,
		})),
	});
	for (const query of [
		"What happened in January 2026?",
		"Qué pasó en enero de 2026",
		"Remember 2026-01?",
		"pottery ceramic Kyoto",
	]) {
		const chapters = await getRelevantChapters(chatId, query);
		expect(chapters).toHaveLength(2);
		expect(chapters[0]?.month).toBe("2026-01");
	}
	expect((await getRelevantChapters(chatId, ""))[0]?.month).toBe("2026-09");
});

test("empty and partial model structures fail rather than erasing accumulated memory", () => {
	for (const raw of [
		{},
		{ summary: "ok", importance: 2 },
		{ summary: "", importance: 1, facts: [] },
	])
		expect(() =>
			validatePromotionResult(JSON.parse(JSON.stringify(raw))),
		).toThrow();
	for (const raw of [
		{},
		{ relationship: { summary: "new" } },
		{ chapter: { title: "New", summary: "new", importance: 3 } },
	])
		expect(() => validateLongTermMemoryUpdate(raw)).toThrow();
	expect(
		validatePromotionResult({
			summary: "casual conversation",
			importance: 1,
			facts: [],
		}).facts,
	).toEqual([]);
});

test("memory prompt budgeting preserves complete lines and does not modify stored facts", async () => {
	expect(
		fitMemorySection(
			"Heading\nshort\nvery long fact beyond budget\ntrailing",
			20,
		),
	).toBe("Heading\nshort");
	const facts = Array.from({ length: 100 }, (_, i) =>
		fact(String(i), { content: "memorable ".repeat(100), archivedAt: now }),
	);
	const before = JSON.stringify(facts);
	const ctx = buildPromptContext({
		relevantFacts: facts,
		permanentFacts: facts,
		relevantEpisodes: [],
		activeNames: ["Ana"],
	});
	const weather = spyOn(weatherCurrent, "render").mockReturnValue(null);
	let prompt: string;
	try {
		prompt = await assembleSystemPrompt(ctx);
	} finally {
		weather.mockRestore();
	}
	expect(prompt).toContain("archived historical memory");
	// Non-memory sections have their own independent content; isolate memory blocks.
	const memoryStart = prompt.indexOf("## Core facts");
	const memoryEnd = prompt.indexOf("## Current", memoryStart);
	const memory = prompt.slice(
		memoryStart,
		memoryEnd < 0 ? undefined : memoryEnd,
	);
	expect(memory.length).toBeLessThan(MEMORY_PROMPT_MAX_CHARS);
	expect(JSON.stringify(facts)).toBe(before);
});
