import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { cosineSimilarity, generateEmbedding } from "./embeddings.ts";
import { getAllAliasesForCanonical } from "./identities.ts";
import type {
	ConversationMessage,
	Episode,
	SemanticFact,
	SensoryBuffer,
	WorkingMemory,
} from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

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
const MAX_PERMANENT_FACTS = 25;
const MEDIA_MESSAGE_COMPACT_TARGET_CHARS = 240;
const UNCOMPRESSED_RECENT_MESSAGES = 2;
const MEDIA_MESSAGE_PATTERNS = [
	{
		regex: /^(\[Audio[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Transcripcion previa comprimida",
	},
	{
		regex: /^(\[Image[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Descripcion visual previa comprimida",
	},
	{
		regex: /^(\[YouTube video[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Resumen previo comprimido",
	},
] as const;

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
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[memory] Error loading permanent.md:", err);
		}
		permanentCache = "You are a helpful conversational bot.";
	}
	return permanentCache;
}

export function clearPermanentCache(): void {
	permanentCache = "";
	permanentLastRead = 0;
}

// --- Name Utilities ---

export function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

function normalizeForCompactPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function compactMediaMessageContent(content: string): string {
	for (const pattern of MEDIA_MESSAGE_PATTERNS) {
		const match = content.match(pattern.regex);
		if (!match) continue;

		const prefix = match[1] ?? content;
		const body = normalizeForCompactPreview(match[2] ?? "");
		if (!body) return prefix;
		if (body.startsWith(`[${pattern.label}]`)) {
			return `${prefix} ${body}`;
		}
		if (body.length <= MEDIA_MESSAGE_COMPACT_TARGET_CHARS) {
			return `${prefix} ${body}`;
		}

		const truncated = body
			.slice(0, MEDIA_MESSAGE_COMPACT_TARGET_CHARS)
			.trimEnd();
		return `${prefix} [${pattern.label}] ${truncated}...`;
	}

	return content;
}

function compactOlderMediaMessages(messages: ConversationMessage[]): void {
	const compactUntil = Math.max(
		0,
		messages.length - UNCOMPRESSED_RECENT_MESSAGES,
	);
	for (let i = 0; i < compactUntil; i++) {
		const message = messages[i];
		if (!message) continue;
		messages[i] = {
			...message,
			content: compactMediaMessageContent(message.content),
		};
	}
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
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error(`[memory] Error loading sensory buffer ${chatId}:`, err);
		}
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
	await atomicWriteFile(
		sensoryPath(buffer.chatId),
		JSON.stringify(buffer, null, 2),
	);
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

	compactOlderMediaMessages(buffer.messages);
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

// --- Keyword Scoring ---

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.split(/\s+/)
			.filter((t) => t.length > 1),
	);
}

/**
 * Compute keyword overlap score between query and candidate text.
 * Returns 0–1: fraction of query tokens found in candidate.
 */
export function computeTextScore(query: string, candidate: string): number {
	const queryTokens = tokenize(query);
	if (queryTokens.size === 0) return 0;
	const candidateTokens = tokenize(candidate);
	let matches = 0;
	for (const token of queryTokens) {
		if (candidateTokens.has(token)) matches++;
	}
	return matches / queryTokens.size;
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

// --- Semantic Memory ---

let semanticCache: SemanticFact[] | null = null;
let semanticLastMtimeMs = 0;

export async function loadSemanticStore(): Promise<SemanticFact[]> {
	try {
		const stat = statSync(SEMANTIC_PATH);
		if (semanticCache && stat.mtimeMs === semanticLastMtimeMs) {
			return semanticCache;
		}
		const data = await readFile(SEMANTIC_PATH, "utf-8");
		semanticCache = JSON.parse(data) as SemanticFact[];
		semanticLastMtimeMs = stat.mtimeMs;
		return semanticCache;
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[memory] Error loading semantic store:", err);
		}
		semanticCache = [];
		return [];
	}
}

export async function saveSemanticStore(facts: SemanticFact[]): Promise<void> {
	semanticCache = facts;
	await atomicWriteFile(SEMANTIC_PATH, JSON.stringify(facts, null, 2));
	// Update mtime to match what we just wrote
	try {
		semanticLastMtimeMs = statSync(SEMANTIC_PATH).mtimeMs;
	} catch {
		// ignore — stat after write is non-critical
	}
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
			// Use lower threshold for same-subject person facts (catch more duplicates)
			const isSamePersonSubject =
				newFact.category === "person" &&
				existing.category === "person" &&
				newFact.subject &&
				existing.subject &&
				normalizeName(newFact.subject) === normalizeName(existing.subject);
			const threshold = isSamePersonSubject ? 0.8 : SEMANTIC_DEDUP_THRESHOLD;
			if (similarity >= threshold) {
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
				// Promote to permanent if new fact is permanent and cap allows
				if (newFact.permanent && !existing.permanent) {
					const permanentCount = store.filter((f) => f.permanent).length;
					if (permanentCount < MAX_PERMANENT_FACTS) {
						existing.permanent = true;
					}
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
			// Enforce permanent fact cap
			if (newFact.permanent) {
				const permanentCount = store.filter((f) => f.permanent).length;
				if (permanentCount >= MAX_PERMANENT_FACTS) {
					if (isDev)
						console.log(
							`[semantic] Permanent fact cap reached (${MAX_PERMANENT_FACTS}), skipping: "${newFact.content.slice(0, 60)}"`,
						);
					continue;
				}
			}
			store.push(newFact);
			if (isDev)
				console.log(
					`[semantic] Added new ${newFact.permanent ? "permanent " : ""}fact: "${newFact.content.slice(0, 60)}"`,
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
		queryText?: string;
	},
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	if (store.length === 0) return [];

	const maxCount = options?.maxCount ?? 15;
	const now = Date.now();

	// Exclude permanent facts (they are always included separately)
	let candidates = store.filter((f) => !f.permanent);

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
		const keywordScore = options?.queryText
			? computeTextScore(options.queryText, fact.content)
			: 0;
		const importanceScore = (fact.importance - 1) / 4;
		const daysSinceConfirmed = (now - fact.lastConfirmed) / 86_400_000;
		const recencyScore = Math.exp(-daysSinceConfirmed / 14); // Half-life ~10 days

		// 40% semantic similarity, 15% keyword, 20% importance, 15% confidence, 10% recency
		const score =
			0.4 * similarity +
			0.15 * keywordScore +
			0.2 * importanceScore +
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
	maxPerSubject = 10,
): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();

	// Expand each name to include all known aliases from identity registry
	const allAliases = new Set<string>();
	for (const name of names) {
		const aliases = await getAllAliasesForCanonical(name);
		for (const alias of aliases) {
			allAliases.add(alias);
		}
	}

	const matching = store.filter(
		(f) =>
			!f.permanent &&
			f.category === "person" &&
			f.subject &&
			allAliases.has(normalizeName(f.subject)),
	);

	// Cap per subject: keep highest importance facts for each
	const bySubject = new Map<string, SemanticFact[]>();
	for (const fact of matching) {
		const key = normalizeName(fact.subject ?? "");
		const list = bySubject.get(key) ?? [];
		list.push(fact);
		bySubject.set(key, list);
	}

	const result: SemanticFact[] = [];
	for (const facts of bySubject.values()) {
		facts.sort((a, b) => b.importance - a.importance);
		result.push(...facts.slice(0, maxPerSubject));
	}
	return result;
}

export async function getPermanentFacts(): Promise<SemanticFact[]> {
	const store = await loadSemanticStore();
	return store.filter((f) => f.permanent === true);
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
		if (fact.permanent) continue;
		const daysSinceConfirmed = (now - fact.lastConfirmed) / 86_400_000;
		fact.confidence = Math.max(
			0,
			fact.confidence - CONFIDENCE_DECAY_RATE * daysSinceConfirmed,
		);
	}

	// Remove facts below minimum confidence (preserve permanent)
	const filtered = store.filter(
		(f) => f.permanent || f.confidence >= MIN_CONFIDENCE,
	);
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
 * Returns the embedding and the raw text used (for hybrid keyword scoring).
 */
export async function getQueryEmbedding(
	messages: ConversationMessage[],
): Promise<{ embedding: number[]; text: string }> {
	const recentText = messages
		.slice(-3)
		.map((m) => m.content)
		.join(" ");
	const embedding = await generateEmbedding(recentText);
	return { embedding, text: recentText };
}

// --- Initialization ---

export async function initMemoryDirs(): Promise<void> {
	if (!existsSync(SENSORY_DIR)) mkdirSync(SENSORY_DIR, { recursive: true });
	if (!existsSync(EPISODES_DIR)) mkdirSync(EPISODES_DIR, { recursive: true });
	// Create semantic.json if it doesn't exist
	if (!existsSync(SEMANTIC_PATH)) {
		await writeFile(SEMANTIC_PATH, "[]");
	}
}
