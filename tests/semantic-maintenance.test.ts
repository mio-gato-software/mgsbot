import { beforeEach, describe, expect, test } from "bun:test";
import {
	addSemanticFacts,
	decayConfidence,
	isFactActive,
	loadSemanticStore,
	saveSemanticStore,
} from "../src/memory/semantic.ts";
import type { SemanticFact } from "../src/types.ts";

const now = Date.now();
function fact(id: string, fields: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id,
		content: "Ana lives in Madrid",
		category: "person",
		subject: "Ana",
		embedding: [1, 0, 0],
		importance: 3,
		confidence: 1,
		createdAt: now,
		lastConfirmed: now,
		...fields,
	};
}
beforeEach(() => saveSemanticStore([]));
describe("semantic corrections and maintenance", () => {
	for (const importance of [2, 3, 4])
		test(`explicit correction remains active with importance ${importance}`, async () => {
			await addSemanticFacts([fact("old")]);
			await addSemanticFacts([
				fact("new", {
					importance,
					content: "Ana now lives in Barcelona",
					supersedes: ["old"],
				}),
			]);
			const facts = await loadSemanticStore();
			expect(
				facts.filter((item) => isFactActive(item)).map((item) => item.content),
			).toEqual(["Ana now lives in Barcelona"]);
			expect(facts.find((item) => item.id === "old")?.supersededBy).toBe("new");
		});
	test("permanent and unrelated facts cannot be retired by supplied IDs", async () => {
		await addSemanticFacts([
			fact("permanent", { permanent: true }),
			fact("other", { subject: "Beto", embedding: [0, 1, 0] }),
		]);
		await addSemanticFacts([
			fact("new", { supersedes: ["permanent", "other", "new"] }),
		]);
		const facts = await loadSemanticStore();
		expect(facts.find((item) => item.id === "permanent")?.permanent).toBe(true);
		expect(facts.every((item) => isFactActive(item))).toBe(true);
	});
	test("replayed dedup effects do not reconfirm a fact twice", async () => {
		await addSemanticFacts([fact("old", { confidence: 0.4 })]);
		await addSemanticFacts([fact("incoming")]);
		await addSemanticFacts([fact("incoming")]);
		const facts = await loadSemanticStore();
		expect(facts).toHaveLength(1);
		expect(facts[0]?.confidence).toBeCloseTo(0.6);
	});
	test("daily decay progresses during uptime and overlapping ticks are harmless", async () => {
		const start = Date.UTC(2040, 0, 1, 12);
		await saveSemanticStore([
			fact("mutable", { createdAt: start, lastConfirmed: start }),
			fact("fixed", {
				subject: "Beto",
				permanent: true,
				createdAt: start,
				lastConfirmed: start,
			}),
		]);
		await Promise.all([
			decayConfidence(start + 86400000),
			decayConfidence(start + 86400000),
		]);
		expect((await loadSemanticStore())[0]?.confidence).toBeCloseTo(0.98);
		await decayConfidence(start + 3 * 86400000);
		const facts = await loadSemanticStore();
		expect(facts[0]?.confidence).toBeCloseTo(0.94);
		expect(facts[1]?.confidence).toBe(1);
	});
});
