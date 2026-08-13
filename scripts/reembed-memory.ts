/**
 * Re-embed Memory Script
 *
 * Regenerates all embeddings in the memory system using the current embedding model.
 * Startup already does this automatically when EMBEDDING_PROVIDER / EMBEDDING_MODEL /
 * EMBEDDING_DIM change (disable with AUTO_REEMBED=false). Use this script to force
 * a full rewrite.
 *
 * Run: bun run scripts/reembed-memory.ts
 */

import { reembedStaleMemory } from "../src/memory/reembed.ts";

const result = await reembedStaleMemory({ force: true });
console.log("[reembed] Done!");
console.log(`[reembed]   Facts re-embedded: ${result.facts}`);
console.log(`[reembed]   Episodes re-embedded: ${result.episodes}`);
console.log(
	`[reembed]   Identity: ${result.identity.provider}/${result.identity.model} (${result.identity.dim}-d)`,
);
