/**
 * Re-embed Memory Script
 *
 * Regenerates all embeddings in the memory system using the current embedding model.
 * Use this after changing the embedding model to ensure all vectors are consistent.
 *
 * What it does:
 * 1. Clears the embedding cache (embedding-cache.json)
 * 2. Re-embeds all semantic facts (semantic.json)
 * 3. Re-embeds all episodes (episodes/<chatId>.json)
 *
 * Run: bun run scripts/reembed-memory.ts
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { flushEmbeddingCache, generateEmbedding } from "../src/embeddings.ts";
import type { SemanticFact, WorkingMemory } from "../src/types.ts";

const SEMANTIC_PATH = "./memory/semantic.json";
const EPISODES_DIR = "./memory/episodes";
const CACHE_PATH = "./memory/embedding-cache.json";

async function reembedSemanticFacts(): Promise<number> {
	if (!existsSync(SEMANTIC_PATH)) {
		console.log("[reembed] No semantic.json found, skipping.");
		return 0;
	}

	const raw = await readFile(SEMANTIC_PATH, "utf-8");
	const facts: SemanticFact[] = JSON.parse(raw);

	console.log(`[reembed] Re-embedding ${facts.length} semantic facts...`);

	for (let i = 0; i < facts.length; i++) {
		const fact = facts[i];
		fact.embedding = await generateEmbedding(fact.content);
		if ((i + 1) % 10 === 0 || i === facts.length - 1) {
			console.log(`[reembed]   ${i + 1}/${facts.length} facts done`);
		}
	}

	await writeFile(SEMANTIC_PATH, JSON.stringify(facts, null, "\t"));
	console.log("[reembed] Saved semantic.json");
	return facts.length;
}

async function reembedEpisodes(): Promise<number> {
	if (!existsSync(EPISODES_DIR)) {
		console.log("[reembed] No episodes directory found, skipping.");
		return 0;
	}

	const files = await readdir(EPISODES_DIR);
	const jsonFiles = files.filter((f) => f.endsWith(".json"));
	let totalEpisodes = 0;

	for (const file of jsonFiles) {
		const filePath = `${EPISODES_DIR}/${file}`;
		const raw = await readFile(filePath, "utf-8");
		const memory: WorkingMemory = JSON.parse(raw);

		if (!memory.episodes || memory.episodes.length === 0) continue;

		console.log(
			`[reembed] Re-embedding ${memory.episodes.length} episodes in ${file}...`,
		);

		for (const episode of memory.episodes) {
			episode.embedding = await generateEmbedding(episode.summary);
		}

		await writeFile(filePath, JSON.stringify(memory, null, "\t"));
		totalEpisodes += memory.episodes.length;
	}

	return totalEpisodes;
}

async function main() {
	console.log("[reembed] Starting re-embedding with current model...\n");

	// Step 1: Clear the embedding cache
	if (existsSync(CACHE_PATH)) {
		await writeFile(CACHE_PATH, JSON.stringify([]));
		console.log("[reembed] Cleared embedding cache.\n");
	}

	// Step 2: Re-embed semantic facts
	const factCount = await reembedSemanticFacts();
	console.log();

	// Step 3: Re-embed episodes
	const episodeCount = await reembedEpisodes();
	console.log();

	// Step 4: Flush cache to disk
	await flushEmbeddingCache();

	console.log("[reembed] Done!");
	console.log(`[reembed]   Facts re-embedded: ${factCount}`);
	console.log(`[reembed]   Episodes re-embedded: ${episodeCount}`);
}

main().catch((err) => {
	console.error("[reembed] Fatal error:", err);
	process.exit(1);
});
