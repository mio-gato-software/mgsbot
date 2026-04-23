import { readFile } from "node:fs/promises";
import { cosineSimilarity } from "../embeddings.ts";
import type { Episode, WorkingMemory } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { computeTextScore } from "./queries.ts";

export const EPISODES_DIR = "./memory/episodes";

const MAX_EPISODES_PER_CHAT = 20;

function episodesPath(chatId: number): string {
	return `${EPISODES_DIR}/${chatId}.json`;
}

export async function loadWorkingMemory(
	chatId: number,
): Promise<WorkingMemory> {
	try {
		const data = await readFile(episodesPath(chatId), "utf-8");
		return JSON.parse(data) as WorkingMemory;
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error(`[memory] Error loading episodes ${chatId}:`, err);
		}
		return { chatId, episodes: [] };
	}
}

export async function saveWorkingMemory(wm: WorkingMemory): Promise<void> {
	await atomicWriteFile(episodesPath(wm.chatId), JSON.stringify(wm, null, 2));
}

export async function addEpisode(
	chatId: number,
	episode: Episode,
): Promise<void> {
	const wm = await loadWorkingMemory(chatId);
	wm.episodes.push(episode);

	// Prune to max episodes by composite score (importance x recency)
	if (wm.episodes.length > MAX_EPISODES_PER_CHAT) {
		const now = Date.now();
		wm.episodes.sort((a, b) => {
			const recencyA = 1 / (1 + (now - a.timestamp) / 86_400_000);
			const recencyB = 1 / (1 + (now - b.timestamp) / 86_400_000);
			return b.importance * recencyB - a.importance * recencyA;
		});
		wm.episodes = wm.episodes.slice(0, MAX_EPISODES_PER_CHAT);
	}

	await saveWorkingMemory(wm);
}

export async function getRelevantEpisodes(
	chatId: number,
	queryEmbedding: number[],
	queryText?: string,
	maxCount = 5,
): Promise<Episode[]> {
	const wm = await loadWorkingMemory(chatId);
	if (wm.episodes.length === 0) return [];

	const now = Date.now();

	const scored = wm.episodes.map((episode) => {
		const similarity = cosineSimilarity(queryEmbedding, episode.embedding);
		const keywordScore = queryText
			? computeTextScore(queryText, episode.summary)
			: 0;
		const importanceScore = (episode.importance - 1) / 4;
		const daysSince = (now - episode.timestamp) / 86_400_000;
		const recencyScore = Math.exp(-daysSince / 7);

		// 40% semantic similarity, 15% keyword, 25% importance, 20% recency
		const score =
			0.4 * similarity +
			0.15 * keywordScore +
			0.25 * importanceScore +
			0.2 * recencyScore;
		return { episode, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, maxCount).map((s) => s.episode);
}
