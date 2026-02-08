import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { consolidateMemberFacts, summarizeConversation } from "./ai.ts";
import type {
	ConversationMessage,
	LongTermMemoryEntry,
	MemberFactExtraction,
	MemberMemory,
	ShortTermMemory,
} from "./types.ts";

const isDev = process.env.NODE_ENV === "development";
const PERMANENT_PATH = "./memory/permanent.md";
const LONG_TERM_PATH = "./memory/long-term.json";
const SHORT_TERM_DIR = "./memory/short-term";
const MEMBER_MEMORY_PATH = "./memory/members.json";

const SUMMARIZE_THRESHOLD = 20;
const SUMMARIZE_COUNT = 10;
const MAX_LONG_TERM_ENTRIES = 50;
const INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const SIMILARITY_THRESHOLD = 0.6; // 60% similarity = duplicate
const MAX_FACTS_PER_MEMBER = 20;

// --- Text Similarity Utilities ---

function normalizeForComparison(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // Remove diacritics
		.replace(/[^\w\s]/g, " ") // Remove punctuation
		.replace(/\s+/g, " ")
		.trim();
}

function extractKeyTerms(text: string): Set<string> {
	const normalized = normalizeForComparison(text);
	const words = normalized.split(" ").filter((w) => w.length > 2);
	const terms = new Set<string>(words);

	// Add bigrams for better matching
	for (let i = 0; i < words.length - 1; i++) {
		terms.add(`${words[i]}_${words[i + 1]}`);
	}

	return terms;
}

function calculateSimilarity(text1: string, text2: string): number {
	const terms1 = extractKeyTerms(text1);
	const terms2 = extractKeyTerms(text2);

	if (terms1.size === 0 || terms2.size === 0) return 0;

	let intersection = 0;
	for (const term of terms1) {
		if (terms2.has(term)) intersection++;
	}

	// Jaccard similarity
	const union = terms1.size + terms2.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

// --- Key Canonicalization for Member Facts ---

const KEY_ALIASES: Record<string, string> = {
	empleo: "trabajo",
	ocupacion: "trabajo",
	profesion: "trabajo",
	oficio: "trabajo",
	bebida: "preferencia-bebida",
	"bebida-favorita": "preferencia-bebida",
	"habito-cafe": "preferencia-bebida",
	cafe: "preferencia-bebida",
	comida: "preferencia-comida",
	"comida-favorita": "preferencia-comida",
	plato: "preferencia-comida",
	"estado-civil": "relacion",
	pareja: "relacion",
	esposo: "relacion",
	esposa: "relacion",
	novio: "relacion",
	novia: "relacion",
	telefono: "contacto-telefono",
	celular: "contacto-telefono",
	movil: "contacto-telefono",
	email: "contacto-email",
	correo: "contacto-email",
	cumpleanos: "fecha-nacimiento",
	nacimiento: "fecha-nacimiento",
	"fecha-cumple": "fecha-nacimiento",
	residencia: "ubicacion",
	ciudad: "ubicacion",
	pais: "ubicacion",
	direccion: "ubicacion",
	casa: "ubicacion",
};

function canonicalizeKey(key: string): string {
	const normalized = normalizeForComparison(key);
	return KEY_ALIASES[normalized] ?? normalized;
}

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
		// Check for duplicates by similarity
		let isDuplicate = false;
		for (const existing of entries) {
			const similarity = calculateSimilarity(mem.content, existing.content);
			if (similarity >= SIMILARITY_THRESHOLD) {
				// Update if new memory has higher importance
				if (mem.importance > existing.importance) {
					existing.content = mem.content;
					existing.context = mem.context;
					existing.importance = mem.importance;
				}
				existing.lastAccessed = now;
				isDuplicate = true;
				break;
			}
		}

		if (!isDuplicate) {
			entries.push({
				id: `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
				content: mem.content,
				context: mem.context,
				createdAt: now,
				lastAccessed: now,
				importance: mem.importance,
			});
		}
	}

	// Prune if over limit
	if (entries.length > MAX_LONG_TERM_ENTRIES) {
		const currentTime = Date.now();
		entries.sort((a, b) => {
			const recencyA = 1 / (1 + (currentTime - a.lastAccessed) / 86_400_000);
			const recencyB = 1 / (1 + (currentTime - b.lastAccessed) / 86_400_000);
			return b.importance * recencyB - a.importance * recencyA;
		});
		entries.length = MAX_LONG_TERM_ENTRIES;
	}

	await saveLongTerm(entries);
}

export function getRelevantMemories(
	entries: LongTermMemoryEntry[],
	currentContext?: string,
	maxCount = 8,
): LongTermMemoryEntry[] {
	if (entries.length === 0) return [];

	const now = Date.now();
	const contextTerms = currentContext ? extractKeyTerms(currentContext) : null;

	// Score each entry with composite scoring
	const scored = entries.map((entry) => {
		// Relevance score (0-1): overlap with current context
		let relevanceScore = 0;
		if (contextTerms && contextTerms.size > 0) {
			const entryTerms = extractKeyTerms(entry.content);
			let overlap = 0;
			for (const term of entryTerms) {
				if (contextTerms.has(term)) overlap++;
			}
			relevanceScore = entryTerms.size > 0 ? overlap / entryTerms.size : 0;
		}

		// Importance score (0-1): normalized from 1-5 scale
		const importanceScore = (entry.importance - 1) / 4;

		// Recency score (0-1): exponential decay over days
		const daysSinceAccess = (now - entry.lastAccessed) / 86_400_000;
		const recencyScore = Math.exp(-daysSinceAccess / 7); // Half-life of ~5 days

		// Composite score: 50% relevance, 30% importance, 20% recency
		// If no context provided, use 60% importance, 40% recency
		const score = contextTerms
			? 0.5 * relevanceScore + 0.3 * importanceScore + 0.2 * recencyScore
			: 0.6 * importanceScore + 0.4 * recencyScore;

		return { entry, score };
	});

	// Sort by score and take top entries
	scored.sort((a, b) => b.score - a.score);
	const selected = scored.slice(0, maxCount).map((s) => s.entry);

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

		const summary = await summarizeConversation(
			conversationText,
			memory.previousSummary || undefined,
		);

		memory.previousSummary = summary;
	}

	await saveShortTerm(memory);
}

// --- Member Memory ---

export function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

export async function loadMemberMemory(): Promise<MemberMemory> {
	try {
		const data = await readFile(MEMBER_MEMORY_PATH, "utf-8");
		return JSON.parse(data) as MemberMemory;
	} catch {
		return {};
	}
}

async function saveMemberMemory(data: MemberMemory): Promise<void> {
	await writeFile(MEMBER_MEMORY_PATH, JSON.stringify(data, null, 2));
}

export async function addMemberFacts(
	facts: MemberFactExtraction[],
): Promise<void> {
	if (facts.length === 0) return;
	const data = await loadMemberMemory();
	const now = Date.now();

	for (const fact of facts) {
		const normalizedNew = normalizeName(fact.member);

		// Find existing member key by normalized comparison
		let existingKey: string | undefined;
		for (const key of Object.keys(data)) {
			if (normalizeName(key) === normalizedNew) {
				existingKey = key;
				break;
			}
		}

		const memberKey = existingKey ?? fact.member;
		if (!data[memberKey]) {
			data[memberKey] = [];
		}

		// Canonicalize the key to avoid duplicates with different naming
		const canonicalKey = canonicalizeKey(fact.key);
		const newFact = {
			key: canonicalKey,
			content: fact.content,
			updatedAt: now,
		};

		// Find existing fact with the same canonical key
		const existingIndex = data[memberKey].findIndex(
			(f) => canonicalizeKey(f.key) === canonicalKey,
		);

		if (existingIndex >= 0) {
			// Update existing fact, keeping the canonical key
			data[memberKey][existingIndex] = newFact;
		} else {
			data[memberKey].push(newFact);
		}
	}

	// Consolidate facts for members that exceed the limit
	const modifiedMembers = new Set(facts.map((f) => f.member));
	for (const memberName of modifiedMembers) {
		// Find the actual key used in data (may differ in casing/accents)
		const normalizedNew = normalizeName(memberName);
		const memberKey = Object.keys(data).find(
			(k) => normalizeName(k) === normalizedNew,
		);
		const memberFacts = memberKey ? data[memberKey] : undefined;
		if (
			!memberKey ||
			!memberFacts ||
			memberFacts.length <= MAX_FACTS_PER_MEMBER
		)
			continue;

		try {
			const targetSize = Math.ceil(MAX_FACTS_PER_MEMBER / 2);
			if (isDev)
				console.log(
					`[member-facts] Consolidating ${memberFacts.length} facts for "${memberKey}" → target ${targetSize}`,
				);
			data[memberKey] = await consolidateMemberFacts(
				memberKey,
				memberFacts,
				targetSize,
			);
		} catch (error) {
			console.error(
				`[member-facts] Consolidation failed for "${memberKey}":`,
				error,
			);
			// Fallback: keep most recent facts
			data[memberKey] = memberFacts
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, MAX_FACTS_PER_MEMBER);
		}
	}

	await saveMemberMemory(data);
}

// --- Initialization ---

export async function initMemoryDirs(): Promise<void> {
	await mkdir("./memory/short-term", { recursive: true }).catch(() => {});
	// Create long-term.json if it doesn't exist
	if (!existsSync(LONG_TERM_PATH)) {
		await writeFile(LONG_TERM_PATH, "[]");
	}
}
