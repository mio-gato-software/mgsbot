import { describe, expect, test } from "bun:test";
import { applyFactRetirements, clusterFactsBySubject } from "../src/janitor.ts";
import type { SemanticFact } from "../src/types.ts";

function makeFact(
	overrides: Partial<SemanticFact> & { id: string },
): SemanticFact {
	return {
		content: "test fact",
		category: "person",
		subject: "Juan Pérez",
		embedding: [],
		importance: 3,
		confidence: 0.8,
		createdAt: Date.now() - 86_400_000,
		lastConfirmed: Date.now() - 86_400_000,
		...overrides,
	};
}

describe("clusterFactsBySubject", () => {
	test("groups active facts by category and normalized subject", () => {
		const store = [
			makeFact({ id: "f1", subject: "Juan Pérez" }),
			makeFact({ id: "f2", subject: "juan pérez" }),
			makeFact({ id: "f3", subject: "Ana" }),
		];
		const clusters = clusterFactsBySubject(store);
		const juanCluster = [...clusters.values()].find((facts) =>
			facts.some((f) => f.id === "f1"),
		);
		expect(juanCluster?.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
	});

	test("skips permanent, retired, and subjectless facts", () => {
		const store = [
			makeFact({ id: "f1", permanent: true }),
			makeFact({ id: "f2", supersededBy: "f9" }),
			makeFact({ id: "f3", subject: undefined, category: "group" }),
			makeFact({ id: "f4" }),
		];
		const clusters = clusterFactsBySubject(store);
		const allIds = [...clusters.values()].flat().map((f) => f.id);
		expect(allIds).toEqual(["f4"]);
	});
});

describe("applyFactRetirements", () => {
	test("retires a contradicted fact and points at its successor", () => {
		const now = Date.now();
		const oldFact = makeFact({ id: "old", content: "works at Acme" });
		const newFact = makeFact({ id: "new", content: "works at Globex" });
		const store = [oldFact, newFact];

		const retired = applyFactRetirements(
			store,
			new Set(["old", "new"]),
			[{ id: "old", supersededBy: "new", reason: "contradicted" }],
			now,
		);

		expect(retired).toBe(1);
		expect(oldFact.supersededBy).toBe("new");
		expect(oldFact.validUntil).toBe(now);
		expect(oldFact.confidence).toBe(0.2);
		expect(newFact.supersededBy).toBeUndefined();
	});

	test("falls back to the janitor sentinel for invalid successors", () => {
		const now = Date.now();
		const fact = makeFact({ id: "dup" });
		const retired = applyFactRetirements(
			[fact],
			new Set(["dup"]),
			[
				// Successor id that doesn't exist, and a self-reference
				{ id: "dup", supersededBy: "ghost", reason: "duplicate" },
			],
			now,
		);
		expect(retired).toBe(1);
		expect(fact.supersededBy).toBe("janitor");
	});

	test("ignores ids outside the reviewed cluster", () => {
		const fact = makeFact({ id: "outside" });
		const retired = applyFactRetirements([fact], new Set(["inside-only"]), [
			{ id: "outside", reason: "hallucinated" },
		]);
		expect(retired).toBe(0);
		expect(fact.supersededBy).toBeUndefined();
	});

	test("never retires permanent facts", () => {
		const fact = makeFact({ id: "perm", permanent: true });
		const retired = applyFactRetirements([fact], new Set(["perm"]), [
			{ id: "perm", reason: "should not happen" },
		]);
		expect(retired).toBe(0);
		expect(fact.supersededBy).toBeUndefined();
	});

	test("does not lower confidence that is already below the floor", () => {
		const fact = makeFact({ id: "weak", confidence: 0.1 });
		applyFactRetirements([fact], new Set(["weak"]), [
			{ id: "weak", reason: "duplicate" },
		]);
		expect(fact.confidence).toBe(0.1);
	});
});
