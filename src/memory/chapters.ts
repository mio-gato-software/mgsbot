import { memoryPath } from "../runtime-paths.ts";
import type { MemoryChapter } from "../types.ts";
import { withChapterLock } from "./locks.ts";
import { computeTextScore, normalizeName } from "./queries.ts";
import { chaptersSchema } from "./schemas.ts";
import { readStore, writeStore } from "./storage.ts";
import { CURRENT_SCHEMA_VERSION } from "./versioning.ts";

export const CHAPTERS_DIR = memoryPath("chapters");

interface ChapterStore {
	schemaVersion?: number; // absent in legacy files; stamped on save
	chatId: number;
	chapters: MemoryChapter[];
}

const MAX_CHAPTERS_PER_CHAT = 18;

function chaptersPath(chatId: number): string {
	return `${CHAPTERS_DIR}/${chatId}.json`;
}

export async function loadChapterStore(chatId: number): Promise<ChapterStore> {
	return readStore(chaptersPath(chatId), chaptersSchema, () => ({
		chatId,
		chapters: [],
	}));
}

export async function saveChapterStore(store: ChapterStore): Promise<void> {
	store.schemaVersion = CURRENT_SCHEMA_VERSION;
	await writeStore(chaptersPath(store.chatId), store, chaptersSchema);
}

export async function getRecentChapters(
	chatId: number,
	maxCount = 2,
): Promise<MemoryChapter[]> {
	const store = await loadChapterStore(chatId);
	return store.chapters
		.slice()
		.sort((a, b) => b.month.localeCompare(a.month))
		.slice(0, maxCount);
}

export async function getChapterForMonth(
	chatId: number,
	month: string,
): Promise<MemoryChapter | null> {
	const store = await loadChapterStore(chatId);
	return store.chapters.find((chapter) => chapter.month === month) ?? null;
}

/**
 * Read-modify-write under the chapter lock. The builder receives the freshly
 * loaded chapter for the month (or null) so merges (participants, episodeIds,
 * importance) can't be computed from a stale pre-lock snapshot.
 */
export async function upsertChapter(
	chatId: number,
	month: string,
	build: (existing: MemoryChapter | null) => MemoryChapter,
): Promise<void> {
	await withChapterLock(chatId, async () => {
		const store = await loadChapterStore(chatId);
		const existingIndex = store.chapters.findIndex(
			(existing) => existing.month === month,
		);
		const chapter = build(
			existingIndex >= 0 ? (store.chapters[existingIndex] ?? null) : null,
		);

		if (existingIndex >= 0) {
			store.chapters[existingIndex] = chapter;
		} else {
			store.chapters.push(chapter);
		}

		store.chapters.sort((a, b) => b.month.localeCompare(a.month));
		store.chapters = store.chapters.slice(0, MAX_CHAPTERS_PER_CHAT);
		await saveChapterStore(store);
	});
}

const MONTH_NAMES = [
	["january", "enero"],
	["february", "febrero"],
	["march", "marzo"],
	["april", "abril"],
	["may", "mayo"],
	["june", "junio"],
	["july", "julio"],
	["august", "agosto"],
	["september", "septiembre", "setiembre"],
	["october", "octubre"],
	["november", "noviembre"],
	["december", "diciembre"],
];

/** Search all retained chapters locally; no model or embedding call is needed. */
export async function getRelevantChapters(
	chatId: number,
	queryText: string,
	maxCount = 2,
): Promise<MemoryChapter[]> {
	const chapters = (await loadChapterStore(chatId)).chapters
		.slice()
		.sort((a, b) => b.month.localeCompare(a.month));
	const query = normalizeName(queryText);
	const words = new Set(query.split(/[^a-z0-9]+/));
	const years: string[] = query.match(/\b(?:19|20)\d{2}\b/g) ?? [];
	const dates: string[] = query.match(/\b\d{4}-\d{2}\b/g) ?? [];
	const months = MONTH_NAMES.flatMap((names, index) =>
		names.some((name) => words.has(name))
			? [String(index + 1).padStart(2, "0")]
			: [],
	);
	return chapters
		.map((chapter, index) => {
			const [year = "", month = ""] = chapter.month.split("-");
			const dateMatch =
				dates.includes(chapter.month) ||
				(months.includes(month) && (!years.length || years.includes(year))) ||
				(!months.length && !dates.length && years.includes(year));
			const relevance = computeTextScore(
				query,
				`${chapter.title} ${chapter.summary}`,
			);
			return {
				chapter,
				score: (dateMatch ? 10 : 0) + relevance * 2 + 0.1 / (index + 1),
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, maxCount)
		.map(({ chapter }) => chapter);
}
