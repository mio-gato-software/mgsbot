import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	currentEmbeddingIdentity,
	embeddingIdentitiesEqual,
	itemNeedsReembed,
	reembedStaleMemory,
	saveStoredEmbeddingConfig,
} from "../src/memory/reembed.ts";
import type { SemanticFact, WorkingMemory } from "../src/types.ts";

const dirs: string[] = [];

process.env.AUTO_REEMBED = "true";

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function makePaths() {
	const root = await mkdtemp(join(tmpdir(), "mgsbot-reembed-"));
	dirs.push(root);
	const episodesDir = join(root, "episodes");
	mkdirSync(episodesDir, { recursive: true });
	return {
		semanticPath: join(root, "semantic.json"),
		episodesDir,
		configPath: join(root, "embedding-config.json"),
	};
}

function fact(id: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id,
		content: `fact ${id}`,
		category: "person",
		embedding: [1, 0],
		embeddingModel: "old-model",
		embeddingDim: 2,
		importance: 3,
		confidence: 1,
		createdAt: 1,
		lastConfirmed: 1,
		...overrides,
	};
}

describe("itemNeedsReembed", () => {
	const current = {
		provider: "openai",
		model: "text-embedding-3-small",
		dim: 768,
	};

	test("keeps matching tagged vectors", () => {
		expect(
			itemNeedsReembed(
				{
					embedding: new Array(768).fill(0),
					embeddingModel: "text-embedding-3-small",
					embeddingDim: 768,
				},
				current,
			),
		).toBe(false);
	});

	test("flags a different model or dimension", () => {
		expect(
			itemNeedsReembed(
				{
					embedding: new Array(768).fill(0),
					embeddingModel: "gemini-embedding-2",
					embeddingDim: 768,
				},
				current,
			),
		).toBe(true);
		expect(
			itemNeedsReembed(
				{
					embedding: new Array(3072).fill(0),
					embeddingModel: "text-embedding-3-small",
					embeddingDim: 3072,
				},
				current,
			),
		).toBe(true);
	});

	test("unknown model is stale only when asked", () => {
		const item = { embedding: new Array(768).fill(0) };
		expect(itemNeedsReembed(item, current)).toBe(false);
		expect(itemNeedsReembed(item, current, true)).toBe(true);
	});

	test("identity comparison is exact", () => {
		expect(
			embeddingIdentitiesEqual(current, {
				provider: "openai",
				model: "text-embedding-3-small",
				dim: 768,
			}),
		).toBe(true);
		expect(
			embeddingIdentitiesEqual(current, { ...current, provider: "gemini" }),
		).toBe(false);
	});
});

describe("reembedStaleMemory", () => {
	test("rewrites stale facts and episodes when the stored config changes", async () => {
		const paths = await makePaths();
		const current = currentEmbeddingIdentity();
		await saveStoredEmbeddingConfig(
			{ provider: "other", model: "other-model", dim: 16 },
			paths.configPath,
		);
		await Bun.write(paths.semanticPath, JSON.stringify([fact("a")]));
		const episodeStore: WorkingMemory = {
			chatId: 1,
			episodes: [
				{
					id: "e1",
					summary: "old episode",
					participants: ["a"],
					timestamp: 1,
					importance: 3,
					embedding: [1, 0],
					embeddingModel: "gemini-embedding-2",
					embeddingDim: 2,
				},
			],
		};
		await Bun.write(
			join(paths.episodesDir, "1.json"),
			JSON.stringify(episodeStore),
		);

		const seen: string[] = [];
		const result = await reembedStaleMemory({
			paths,
			embed: async (text) => {
				seen.push(text);
				return [7, 7, 7];
			},
		});

		expect(result.ran).toBe(true);
		expect(result.reason).toBe("config-changed");
		expect(result.facts).toBe(1);
		expect(result.episodes).toBe(1);
		expect(seen).toEqual(["fact a", "old episode"]);

		const facts = JSON.parse(
			await Bun.file(paths.semanticPath).text(),
		) as SemanticFact[];
		expect(facts[0]?.embedding).toEqual([7, 7, 7]);
		expect(facts[0]?.embeddingModel).toBe(current.model);
		expect(facts[0]?.embeddingDim).toBe(3);
	});

	test("skips a second startup when nothing is stale", async () => {
		const paths = await makePaths();
		await reembedStaleMemory({
			paths,
			embed: async () => [1],
		});
		const second = await reembedStaleMemory({
			paths,
			embed: async () => {
				throw new Error("should not embed");
			},
		});
		expect(second.ran).toBe(false);
		expect(second.reason).toBe("unchanged");
	});

	test("does not rewrite untagged vectors until the config actually changes", async () => {
		const paths = await makePaths();
		const current = currentEmbeddingIdentity();
		await Bun.write(
			paths.semanticPath,
			JSON.stringify([
				fact("legacy", {
					embedding: new Array(current.dim).fill(0),
					embeddingDim: current.dim,
					embeddingModel: undefined,
				}),
			]),
		);
		const first = await reembedStaleMemory({
			paths,
			embed: async () => [1],
		});
		expect(first.ran).toBe(false);

		await saveStoredEmbeddingConfig(
			{ provider: "other", model: "other-model", dim: 16 },
			paths.configPath,
		);
		const second = await reembedStaleMemory({
			paths,
			embed: async () => [2, 2],
		});
		expect(second.ran).toBe(true);
		expect(second.facts).toBe(1);
	});

	test("AUTO_REEMBED=false skips automatic rewrites", async () => {
		const previous = process.env.AUTO_REEMBED;
		process.env.AUTO_REEMBED = "false";
		try {
			const paths = await makePaths();
			await Bun.write(paths.semanticPath, JSON.stringify([fact("a")]));
			const result = await reembedStaleMemory({
				paths,
				embed: async () => {
					throw new Error("should not embed");
				},
			});
			expect(result.ran).toBe(false);
			expect(result.reason).toBe("disabled");
		} finally {
			process.env.AUTO_REEMBED = previous;
		}
	});
});
