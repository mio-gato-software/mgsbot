import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cosineSimilarity, generateEmbedding } from "./embeddings.ts";
import type {
	ConversationMessage,
	Episode,
	SemanticFact,
	SensoryBuffer,
	WorkingMemory,
} from "./types.ts";

const isDev = process.env.NODE_ENV === "development";

const PERMANENT_PATH = "./memory/permanent.md";
const SEMANTIC_PATH = "./memory/semantic.json";
const SENSORY_DIR = "./memory/sensory";
const EPISODES_DIR = "./memory/episodes";

const SENSORY_MAX_MESSAGES = 10;
const SENSORY_OVERFLOW_COUNT = 5; // Messages returned on overflow
const MAX_EPISODES_PER_CHAT = 20;
const INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const SEMANTIC_DEDUP_THRESHOLD = 0.85;
const CONFIDENCE_DECAY_RATE = 0.02; // Per day
const MIN_CONFIDENCE = 0.1;

// --- Permanent Memory (unchanged) ---

let permanentCache = "";
let permanentLastRead = 0;
const PERMANENT_CACHE_MS = 60_000;

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

// --- Name Utilities ---

export function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

// --- Sensory Buffer ---

function sensoryPath(chatId: number): string {
	return `${SENSORY_DIR}/${chatId}.json`;
}

export async function loadSensory(chatId: number): Promise<SensoryBuffer> {
	try {
		const data = await readFile(sensoryPath(chatId), "utf-8");
		const buffer = JSON.parse(data) as SensoryBuffer;

		// Clear messages if inactive for > 3 days
		if (Date.now() - buffer.lastActivity > INACTIVITY_THRESHOLD_MS) {
			buffer.messages = [];
		}

		return buffer;
	} catch {
		return {
			chatId,
			messages: [],
			lastActivity: Date.now(),
			messageCountSincePromotion: 0,
		};
	}
}

export async function saveSensory(buffer: SensoryBuffer): Promise<void> {
	buffer.lastActivity = Date.now();
	await writeFile(sensoryPath(buffer.chatId), JSON.stringify(buffer, null, 2));
}

/**
 * Add a message to the sensory buffer.
 * Returns overflow messages (oldest 5) if buffer exceeds 10, otherwise null.
 */
export async function addMessageToSensory(
	buffer: SensoryBuffer,
	message: ConversationMessage,
): Promise<ConversationMessage[] | null> {
	buffer.messages.push(message);
	buffer.messageCountSincePromotion++;

	let overflow: ConversationMessage[] | null = null;

	if (buffer.messages.length > SENSORY_MAX_MESSAGES) {
		overflow = buffer.messages.slice(0, SENSORY_OVERFLOW_COUNT);
		buffer.messages = buffer.messages.slice(SENSORY_OVERFLOW_COUNT);
	}

	await saveSensory(buffer);
	return overflow;
}

// --- Working Memory (Episodes) ---

function episodesPath(chatId: number): string {
	return `${EPISODES_DIR}/${chatId}.json`;
}

export async function loadWorkingMemory(
	chatId: number,
): Promise<WorkingMemory> {
	try {
		const data = await readFile(episodesPath(chatId), "utf-8");
		return JSON.parse(data) as WorkingMemory;
	} catch {
		return { chatId, episodes: [] };
	}
}

export async function saveWorkingMemory(wm: WorkingMemory): Promise<void> {
	await writeFile(episodesPath(wm.chatId), JSON.stringify(wm, null, 2));
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
	maxCount = 5,
): Promise<Episode[]> {
	const wm = await loadWorkingMemory(chatId);
	if (wm.episodes.length === 0) return [];

	const now = Date.now();

	const scored = wm.episodes.map((episode) => {
		const similarity = cosineSimilarity(queryEmbedding, episode.embedding);
		const importanceScore = (episode.importance - 1) / 4;
		const daysSince = (now - episode.timestamp) / 86_400_000;
		const recencyScore = Math.exp(-daysSince / 7);

		// 50% semantic similarity, 30% importance, 20% recency
		const score = 0.5 * similarity + 0.3 * importanceScore + 0.2 * recencyScore;
		return { episode, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, maxCount).map((s) => s.episode);
}

// --- Semantic Memory ---

let semanticCache: SemanticFact[] | null = null;

export async function loadSemanticStore(): Promise<SemanticFact[]> {
	if (semanticCache) return semanticCache;
	try {
		const data = await readFile(SEMANTIC_PATH, "utf-8");
		semanticCache = JSON.parse(data) as SemanticFact[];
		return semanticCache;
	} catch {
		semanticCache = [];
		return [];
	}
}

export async function saveSemanticStore(facts: SemanticFact[]): Promise<void> {
	semanticCache = facts;
	await writeFile(SEMANTIC_PATH, JSON.stringify(facts, null, 2));
}

export async function addSemanticFacts(
	newFacts: SemanticFact[],
): Promise<void> {
	const store = await loadSemanticStore();
	const now = Date.now();

	for (const newFact of newFacts) {
		// Find similar existing facts by embedding
		let merged = false;
		for (const existing of store) {
			const similarity = cosineSimilarity(
				newFact.embedding,
				existing.embedding,
			);
			if (similarity >= SEMANTIC_DEDUP_THRESHOLD) {
				// Update existing: refresh confidence and timestamp
				existing.lastConfirmed = now;
				existing.confidence = Math.min(1, existing.confidence + 0.2);
				// Update content if new fact has higher importance
				if (newFact.importance > existing.importance) {
					existing.content = newFact.content;
					existing.context = newFact.context;
					existing.importance = newFact.importance;
					existing.embedding = newFact.embedding;
				}
				merged = true;
				if (isDev)
					console.log(
						`[semantic] Merged duplicate (similarity=${similarity.toFixed(2)}): "${newFact.content.slice(0, 60)}"`,
					);
				break;
			}
		}

		if (!merged) {
			store.push(newFact);
			if (isDev)
				console.log(
					`[semantic] Added new fact: "${newFact.content.slice(0, 60)}"`,
				);
		}
	}

	await saveSemanticStore(store);
}

export async function getRelevantFacts(
	queryEmbedding: number[],
	options?: {
		category?: SemanticFact["category"];
		subject?: string;
		maxCount?: number;
	},
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	if (store.length === 0) return [];

	const maxCount = options?.maxCount ?? 15;
	const now = Date.now();

	let candidates = store;

	// Filter by category if specified
	if (options?.category) {
		candidates = candidates.filter((f) => f.category === options.category);
	}

	// Filter by subject if specified
	if (options?.subject) {
		const normalizedSubject = normalizeName(options.subject);
		candidates = candidates.filter(
			(f) => f.subject && normalizeName(f.subject) === normalizedSubject,
		);
	}

	const scored = candidates.map((fact) => {
		const similarity = cosineSimilarity(queryEmbedding, fact.embedding);
		const importanceScore = (fact.importance - 1) / 4;
		const daysSinceConfirmed = (now - fact.lastConfirmed) / 86_400_000;
		const recencyScore = Math.exp(-daysSinceConfirmed / 14); // Half-life ~10 days

		// 50% semantic similarity, 25% importance, 15% confidence, 10% recency
		const score =
			0.5 * similarity +
			0.25 * importanceScore +
			0.15 * fact.confidence +
			0.1 * recencyScore;

		return { fact, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, maxCount).map((s) => s.fact);
}

/**
 * Get all facts for specific subjects (for prompt building).
 * No embedding query needed — returns all facts for the given names.
 */
export async function getFactsForSubjects(
	names: string[],
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	const normalizedNames = new Set(names.map(normalizeName));
	return store.filter(
		(f) =>
			f.category === "person" &&
			f.subject &&
			normalizedNames.has(normalizeName(f.subject)),
	);
}

let lastDecayDate = "";

export async function decayConfidence(): Promise<{
	total: number;
	removed: number;
}> {
	const today = new Date().toISOString().slice(0, 10);
	if (lastDecayDate === today) {
		const store = await loadSemanticStore();
		return { total: store.length, removed: 0 };
	}

	const store = await loadSemanticStore();
	const totalBefore = store.length;
	const now = Date.now();

	for (const fact of store) {
		const daysSinceConfirmed = (now - fact.lastConfirmed) / 86_400_000;
		fact.confidence = Math.max(
			0,
			fact.confidence - CONFIDENCE_DECAY_RATE * daysSinceConfirmed,
		);
	}

	// Remove facts below minimum confidence
	const filtered = store.filter((f) => f.confidence >= MIN_CONFIDENCE);
	const removed = totalBefore - filtered.length;

	if (removed > 0 && isDev) {
		console.log(`[semantic] Decayed confidence: removed ${removed} facts`);
	}

	await saveSemanticStore(filtered);
	lastDecayDate = today;

	return { total: filtered.length, removed };
}

// --- Heuristic Pre-filter ---

const SIGNIFICANT_PATTERNS = [
	// Personal declarations (Spanish)
	/\b(soy|trabajo en|me gusta|tengo|vivo en|estudio|naci)\b/i,
	// Dates and events
	/\b\d{1,2}\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i,
	// Memory references
	/\b(recuerdas?|te cont[eé]|te dije|ya te|mencion[eé])\b/i,
	// Names (capitalized words after common intro patterns)
	/\b(se llama|mi (hijo|hija|esposo|esposa|novio|novia|amigo|amiga|hermano|hermana|padre|madre|jefe)|soy)\s+[A-Z]/,
	// Numbers that could be ages, dates, amounts
	/\b\d{2,4}\s*(años|año)\b/i,
];

const MIN_SIGNIFICANT_LENGTH = 120;

export function hasSignificantContent(
	messages: ConversationMessage[],
): boolean {
	for (const msg of messages) {
		// Long messages are often significant
		if (msg.content.length > MIN_SIGNIFICANT_LENGTH) return true;

		// Check for significant patterns
		for (const pattern of SIGNIFICANT_PATTERNS) {
			if (pattern.test(msg.content)) return true;
		}
	}
	return false;
}

// --- Query Embedding Helper ---

/**
 * Generate a query embedding from recent messages for retrieval.
 */
export async function getQueryEmbedding(
	messages: ConversationMessage[],
): Promise<number[]> {
	// Use the last few messages as context for the query
	const recentText = messages
		.slice(-3)
		.map((m) => m.content)
		.join(" ");
	return generateEmbedding(recentText);
}

// --- Initialization ---

export async function initMemoryDirs(): Promise<void> {
	await mkdir(SENSORY_DIR, { recursive: true }).catch(() => {});
	await mkdir(EPISODES_DIR, { recursive: true }).catch(() => {});
	// Create semantic.json if it doesn't exist
	if (!existsSync(SEMANTIC_PATH)) {
		await writeFile(SEMANTIC_PATH, "[]");
	}
}
