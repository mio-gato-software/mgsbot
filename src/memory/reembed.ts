import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolveEmbeddingProvider } from "../ai/platform.ts";
import {
	clearEmbeddingCache,
	flushEmbeddingCache,
	generateEmbedding,
	getEmbeddingDim,
	getEmbeddingModel,
} from "../embeddings.ts";
import { log } from "../logger.ts";
import type { SemanticFact, WorkingMemory } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { EPISODES_DIR } from "./episodes.ts";
import { SEMANTIC_PATH, saveSemanticStore } from "./semantic.ts";
import { unwrapVersioned } from "./versioning.ts";

export const EMBEDDING_CONFIG_PATH = "./memory/embedding-config.json";

export interface EmbeddingIdentity {
	provider: string;
	model: string;
	dim: number;
}

export interface ReembedPaths {
	semanticPath?: string;
	episodesDir?: string;
	configPath?: string;
}

export interface ReembedResult {
	ran: boolean;
	reason?: string;
	facts: number;
	episodes: number;
	identity: EmbeddingIdentity;
}

interface StoredEmbeddingConfig extends EmbeddingIdentity {
	updatedAt: number;
}

export function currentEmbeddingIdentity(): EmbeddingIdentity {
	return {
		provider: resolveEmbeddingProvider(),
		model: getEmbeddingModel(),
		dim: getEmbeddingDim(),
	};
}

export function embeddingIdentitiesEqual(
	a: EmbeddingIdentity,
	b: EmbeddingIdentity,
): boolean {
	return a.provider === b.provider && a.model === b.model && a.dim === b.dim;
}

export function itemNeedsReembed(
	item: {
		embedding?: number[];
		embeddingModel?: string;
		embeddingDim?: number;
	},
	current: EmbeddingIdentity,
	treatUnknownAsStale = false,
): boolean {
	if (!item.embedding?.length) return true;
	const dim = item.embeddingDim ?? item.embedding.length;
	if (dim !== current.dim) return true;
	if (item.embeddingModel) return item.embeddingModel !== current.model;
	return treatUnknownAsStale;
}

export async function loadStoredEmbeddingConfig(
	configPath = EMBEDDING_CONFIG_PATH,
): Promise<EmbeddingIdentity | null> {
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<StoredEmbeddingConfig>;
		if (
			typeof parsed.provider === "string" &&
			typeof parsed.model === "string" &&
			typeof parsed.dim === "number"
		) {
			return {
				provider: parsed.provider,
				model: parsed.model,
				dim: parsed.dim,
			};
		}
		return null;
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.warn("[reembed] Failed to read embedding config:", err);
		}
		return null;
	}
}

export async function saveStoredEmbeddingConfig(
	identity: EmbeddingIdentity,
	configPath = EMBEDDING_CONFIG_PATH,
): Promise<void> {
	const payload: StoredEmbeddingConfig = {
		...identity,
		updatedAt: Date.now(),
	};
	await atomicWriteFile(configPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function autoReembedEnabled(): boolean {
	return process.env.AUTO_REEMBED !== "false";
}

async function loadSemanticFacts(path: string): Promise<SemanticFact[]> {
	if (!existsSync(path)) return [];
	const raw = await readFile(path, "utf-8");
	return unwrapVersioned<SemanticFact[]>(JSON.parse(raw));
}

async function loadEpisodeStores(
	episodesDir: string,
): Promise<Array<{ path: string; memory: WorkingMemory }>> {
	if (!existsSync(episodesDir)) return [];
	const files = (await readdir(episodesDir)).filter((file) =>
		file.endsWith(".json"),
	);
	const stores: Array<{ path: string; memory: WorkingMemory }> = [];
	for (const file of files) {
		const path = `${episodesDir}/${file}`;
		const raw = await readFile(path, "utf-8");
		stores.push({ path, memory: JSON.parse(raw) as WorkingMemory });
	}
	return stores;
}

export async function findStaleEmbeddingCounts(
	current: EmbeddingIdentity,
	paths: ReembedPaths = {},
	treatUnknownAsStale = false,
): Promise<{ facts: number; episodes: number }> {
	const semanticPath = paths.semanticPath ?? SEMANTIC_PATH;
	const episodesDir = paths.episodesDir ?? EPISODES_DIR;
	const facts = await loadSemanticFacts(semanticPath);
	const stores = await loadEpisodeStores(episodesDir);
	return {
		facts: facts.filter((fact) =>
			itemNeedsReembed(fact, current, treatUnknownAsStale),
		).length,
		episodes: stores.reduce(
			(count, store) =>
				count +
				(store.memory.episodes ?? []).filter((episode) =>
					itemNeedsReembed(episode, current, treatUnknownAsStale),
				).length,
			0,
		),
	};
}

export async function reembedStaleMemory(options?: {
	embed?: (text: string) => Promise<number[]>;
	force?: boolean;
	paths?: ReembedPaths;
}): Promise<ReembedResult> {
	const current = currentEmbeddingIdentity();
	const paths = options?.paths ?? {};
	const semanticPath = paths.semanticPath ?? SEMANTIC_PATH;
	const episodesDir = paths.episodesDir ?? EPISODES_DIR;
	const configPath = paths.configPath ?? EMBEDDING_CONFIG_PATH;
	const embed = options?.embed ?? generateEmbedding;

	if (!options?.force && !autoReembedEnabled()) {
		return {
			ran: false,
			reason: "disabled",
			facts: 0,
			episodes: 0,
			identity: current,
		};
	}

	const stored = await loadStoredEmbeddingConfig(configPath);
	const configChanged = !!stored && !embeddingIdentitiesEqual(stored, current);
	const treatUnknownAsStale = options?.force || configChanged;
	const stale = await findStaleEmbeddingCounts(
		current,
		{ semanticPath, episodesDir },
		treatUnknownAsStale,
	);
	const needsWork = stale.facts > 0 || stale.episodes > 0;

	if (!options?.force && !needsWork) {
		if (!stored || configChanged) {
			await saveStoredEmbeddingConfig(current, configPath);
		}
		return {
			ran: false,
			reason: stored ? "unchanged" : "already-current",
			facts: 0,
			episodes: 0,
			identity: current,
		};
	}

	const reason = options?.force
		? "forced"
		: configChanged
			? "config-changed"
			: stored
				? "stale-vectors"
				: "untracked-mismatch";
	log.info(
		`[reembed] ${reason}: ${current.provider}/${current.model} (${current.dim}-d). Updating ${stale.facts} facts and ${stale.episodes} episodes.`,
	);

	// Only wipe the on-disk LRU when the embedding identity changed or the
	// operator forced a full rewrite. A stale-vectors pass can reuse cache
	// entries that already match the current model+dim.
	if (!options?.paths && (options?.force || configChanged)) {
		await clearEmbeddingCache();
	}

	const facts = await loadSemanticFacts(semanticPath);
	let factCount = 0;
	for (const fact of facts) {
		if (
			!options?.force &&
			!itemNeedsReembed(fact, current, treatUnknownAsStale)
		)
			continue;
		fact.embedding = await embed(fact.content);
		fact.embeddingModel = current.model;
		fact.embeddingDim = fact.embedding.length;
		factCount++;
		if (factCount % 25 === 0) {
			log.info(`[reembed] Facts ${factCount}/${facts.length}`);
		}
	}
	if (factCount > 0) {
		if (semanticPath === SEMANTIC_PATH) {
			await saveSemanticStore(facts);
		} else {
			await atomicWriteFile(semanticPath, JSON.stringify(facts, null, 2));
		}
	}

	const stores = await loadEpisodeStores(episodesDir);
	let episodeCount = 0;
	for (const store of stores) {
		let dirty = false;
		for (const episode of store.memory.episodes ?? []) {
			if (
				!options?.force &&
				!itemNeedsReembed(episode, current, treatUnknownAsStale)
			)
				continue;
			episode.embedding = await embed(episode.summary);
			episode.embeddingModel = current.model;
			episode.embeddingDim = episode.embedding.length;
			episodeCount++;
			dirty = true;
		}
		if (dirty) {
			// Startup-only today (before handlers register). If this is ever
			// triggered at runtime, wrap the write in withChatLock(chatId).
			await atomicWriteFile(store.path, JSON.stringify(store.memory, null, 2));
		}
	}

	if (!options?.paths) {
		await flushEmbeddingCache();
	}
	await saveStoredEmbeddingConfig(current, configPath);

	log.info(`[reembed] Done. Facts: ${factCount}. Episodes: ${episodeCount}.`);
	return {
		ran: true,
		reason,
		facts: factCount,
		episodes: episodeCount,
		identity: current,
	};
}
