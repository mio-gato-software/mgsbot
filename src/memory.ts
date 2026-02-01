import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateResponse } from "./ai.ts";
import type {
	ConversationMessage,
	LongTermMemoryEntry,
	ShortTermMemory,
} from "./types.ts";

const PERMANENT_PATH = "./memory/permanent.md";
const LONG_TERM_PATH = "./memory/long-term.json";
const SHORT_TERM_DIR = "./memory/short-term";

const SUMMARIZE_THRESHOLD = 30;
const SUMMARIZE_COUNT = 15;
const MAX_LONG_TERM_ENTRIES = 50;
const INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// --- Permanent Memory ---

let permanentCache: string = "";
let permanentLastRead = 0;
const PERMANENT_CACHE_MS = 60_000; // Re-read every minute

export async function loadPermanent(): Promise<string> {
	const now = Date.now();
	if (permanentCache && now - permanentLastRead < PERMANENT_CACHE_MS) {
		return permanentCache;
	}
	try {
		permanentCache = await readFile(PERMANENT_PATH, "utf-8");
		permanentLastRead = now;
	} catch {
		permanentCache = "You are a helpful conversational bot.";
	}
	return permanentCache;
}

// --- Long-Term Memory ---

export async function loadLongTerm(): Promise<LongTermMemoryEntry[]> {
	try {
		const data = await readFile(LONG_TERM_PATH, "utf-8");
		return JSON.parse(data) as LongTermMemoryEntry[];
	} catch {
		return [];
	}
}

export async function saveLongTerm(
	entries: LongTermMemoryEntry[],
): Promise<void> {
	await writeFile(LONG_TERM_PATH, JSON.stringify(entries, null, 2));
}

export async function addLongTermMemories(
	newMemories: Array<{ content: string; context: string; importance: number }>,
): Promise<void> {
	const entries = await loadLongTerm();
	const now = Date.now();

	for (const mem of newMemories) {
		entries.push({
			id: `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
			content: mem.content,
			context: mem.context,
			createdAt: now,
			lastAccessed: now,
			importance: mem.importance,
		});
	}

	// Prune if over limit
	if (entries.length > MAX_LONG_TERM_ENTRIES) {
		const now = Date.now();
		entries.sort((a, b) => {
			const recencyA = 1 / (1 + (now - a.lastAccessed) / 86_400_000);
			const recencyB = 1 / (1 + (now - b.lastAccessed) / 86_400_000);
			return b.importance * recencyB - a.importance * recencyA;
		});
		entries.length = MAX_LONG_TERM_ENTRIES;
	}

	await saveLongTerm(entries);
}

export function getRelevantMemories(
	entries: LongTermMemoryEntry[],
): LongTermMemoryEntry[] {
	if (entries.length === 0) return [];

	const now = Date.now();

	// Get 10 most recently accessed
	const byRecency = [...entries]
		.sort((a, b) => b.lastAccessed - a.lastAccessed)
		.slice(0, 10);

	// Get 5 highest importance (excluding those already selected)
	const recencyIds = new Set(byRecency.map((e) => e.id));
	const byImportance = entries
		.filter((e) => !recencyIds.has(e.id))
		.sort((a, b) => b.importance - a.importance)
		.slice(0, 5);

	const selected = [...byRecency, ...byImportance];

	// Update lastAccessed for selected entries
	const selectedIds = new Set(selected.map((e) => e.id));
	for (const entry of entries) {
		if (selectedIds.has(entry.id)) {
			entry.lastAccessed = now;
		}
	}

	return selected;
}

// --- Short-Term Memory ---

function shortTermPath(chatId: number): string {
	return `${SHORT_TERM_DIR}/${chatId}.json`;
}

export async function loadShortTerm(chatId: number): Promise<ShortTermMemory> {
	try {
		const data = await readFile(shortTermPath(chatId), "utf-8");
		const memory = JSON.parse(data) as ShortTermMemory;

		// Clear messages if inactive for > 3 days
		if (Date.now() - memory.lastActivity > INACTIVITY_THRESHOLD_MS) {
			memory.messages = [];
		}

		return memory;
	} catch {
		return {
			chatId,
			messages: [],
			previousSummary: "",
			lastActivity: Date.now(),
			messageCountSinceEval: 0,
		};
	}
}

export async function saveShortTerm(memory: ShortTermMemory): Promise<void> {
	memory.lastActivity = Date.now();
	await writeFile(
		shortTermPath(memory.chatId),
		JSON.stringify(memory, null, 2),
	);
}

export async function addMessageToShortTerm(
	memory: ShortTermMemory,
	message: ConversationMessage,
): Promise<void> {
	memory.messages.push(message);
	memory.messageCountSinceEval++;

	// Rolling window: summarize oldest messages when exceeding threshold
	if (memory.messages.length > SUMMARIZE_THRESHOLD) {
		const toSummarize = memory.messages.slice(0, SUMMARIZE_COUNT);
		memory.messages = memory.messages.slice(SUMMARIZE_COUNT);

		const conversationText = toSummarize
			.map(
				(m) =>
					`${m.role === "user" ? (m.name ?? "User") : "Bot"}: ${m.content}`,
			)
			.join("\n");

		const existingSummary = memory.previousSummary
			? `Previous context: ${memory.previousSummary}\n\n`
			: "";

		const summary = await generateResponse(
			"You are a summarizer. Create a concise summary of the conversation, preserving key facts, decisions, and context. Keep it under 200 words.",
			[
				{
					role: "user",
					parts: [
						{
							text: `${existingSummary}Conversation to summarize:\n${conversationText}`,
						},
					],
				},
			],
		);

		memory.previousSummary = summary;
	}

	await saveShortTerm(memory);
}

// --- Initialization ---

export async function initMemoryDirs(): Promise<void> {
	await mkdir("./memory/short-term", { recursive: true }).catch(() => {});
	// Create long-term.json if it doesn't exist
	if (!existsSync(LONG_TERM_PATH)) {
		await writeFile(LONG_TERM_PATH, "[]");
	}
}
