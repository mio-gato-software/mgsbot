import { readFile } from "node:fs/promises";
import { log } from "../logger.ts";
import type { MemoryChapter } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { withChapterLock } from "./locks.ts";
import { CURRENT_SCHEMA_VERSION } from "./versioning.ts";

export const CHAPTERS_DIR = "./memory/chapters";

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
	try {
		const data = await readFile(chaptersPath(chatId), "utf-8");
		return JSON.parse(data) as ChapterStore;
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error(`[memory] Error loading chapters ${chatId}:`, err);
		}
		return { chatId, chapters: [] };
	}
}

export async function saveChapterStore(store: ChapterStore): Promise<void> {
	store.schemaVersion = CURRENT_SCHEMA_VERSION;
	await atomicWriteFile(
		chaptersPath(store.chatId),
		JSON.stringify(store, null, 2),
	);
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
