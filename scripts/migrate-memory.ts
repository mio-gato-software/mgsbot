/**
 * Memory Migration Script
 *
 * Migrates from the old 3-tier memory system to the new 4-tier architecture:
 * - long-term.json + members.json → semantic.json
 * - short-term/<id>.json → sensory/<id>.json + episodes/<id>.json
 *
 * Run: bun run scripts/migrate-memory.ts
 */

import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});
const EMBEDDING_MODEL = "gemini-embedding-2";

// --- Types (old) ---

interface OldShortTermMemory {
	chatId: number;
	messages: Array<{
		role: "user" | "model";
		name?: string;
		content: string;
		timestamp: number;
	}>;
	previousSummary: string;
	lastActivity: number;
	messageCountSinceEval: number;
	lastImageDate?: string;
	imageTargetTime?: string;
	imageTargetDate?: string;
}

interface OldLongTermEntry {
	id: string;
	content: string;
	context: string;
	createdAt: number;
	lastAccessed: number;
	importance: number;
}

interface OldMemberFact {
	key: string;
	content: string;
	updatedAt: number;
}

interface OldMemberMemory {
	[memberName: string]: OldMemberFact[];
}

// --- Types (new) ---

interface SemanticFact {
	id: string;
	content: string;
	category: "person" | "group" | "rule" | "event";
	subject?: string;
	context?: string;
	embedding: number[];
	importance: number;
	confidence: number;
	createdAt: number;
	lastConfirmed: number;
}

interface Episode {
	id: string;
	summary: string;
	participants: string[];
	timestamp: number;
	importance: number;
	embedding: number[];
}

interface SensoryBuffer {
	chatId: number;
	messages: Array<{
		role: "user" | "model";
		name?: string;
		content: string;
		timestamp: number;
	}>;
	lastActivity: number;
	messageCountSincePromotion: number;
	lastImageDate?: string;
	imageTargetTime?: string;
	imageTargetDate?: string;
}

interface WorkingMemory {
	chatId: number;
	episodes: Episode[];
}

// --- Embedding helpers ---

async function generateEmbedding(text: string): Promise<number[]> {
	const response = await ai.models.embedContent({
		model: EMBEDDING_MODEL,
		contents: text,
	});
	const embedding = response.embeddings?.[0]?.values;
	if (!embedding) throw new Error(`No embedding for: "${text.slice(0, 60)}"`);
	return embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

// --- Category inference ---

// Add your own known person names here for better category inference during migration
const PERSON_PATTERNS = /(?!)/; // Matches nothing by default — customize if needed
const EVENT_PATTERNS =
	/\b(evento|feriado|fecha|cumpleaños|27 de febrero|independencia|navidad|año nuevo)\b/i;
const RULE_PATTERNS =
	/\b(regla|límite|primero el café|no (permite|acepta|tolera))\b/i;

function inferCategory(content: string): "person" | "group" | "rule" | "event" {
	if (RULE_PATTERNS.test(content)) return "rule";
	if (EVENT_PATTERNS.test(content)) return "event";
	if (PERSON_PATTERNS.test(content)) return "person";
	return "group";
}

function inferSubject(_content: string): string | undefined {
	// No default names — category inference handles "person" via PERSON_PATTERNS
	return undefined;
}

// --- Main migration ---

async function migrate(): Promise<void> {
	console.log("=== Memory Migration: Old → New Architecture ===\n");

	// 1. Create new directories
	await mkdir("./memory/sensory", { recursive: true });
	await mkdir("./memory/episodes", { recursive: true });

	// 2. Backup old files
	console.log("📦 Backing up old files...");
	if (existsSync("./memory/long-term.json")) {
		await copyFile("./memory/long-term.json", "./memory/long-term.backup.json");
		console.log("  ✓ long-term.json → long-term.backup.json");
	}
	if (existsSync("./memory/members.json")) {
		await copyFile("./memory/members.json", "./memory/members.backup.json");
		console.log("  ✓ members.json → members.backup.json");
	}

	// 3. Load old data
	let longTermEntries: OldLongTermEntry[] = [];
	let memberMemory: OldMemberMemory = {};

	try {
		const data = await readFile("./memory/long-term.json", "utf-8");
		longTermEntries = JSON.parse(data);
		console.log(`\n📖 Loaded ${longTermEntries.length} long-term entries`);
	} catch {
		console.log("\n📖 No long-term.json found (starting fresh)");
	}

	try {
		const data = await readFile("./memory/members.json", "utf-8");
		memberMemory = JSON.parse(data);
		const memberCount = Object.keys(memberMemory).length;
		const factCount = Object.values(memberMemory).reduce(
			(sum, facts) => sum + facts.length,
			0,
		);
		console.log(
			`📖 Loaded ${factCount} member facts across ${memberCount} members`,
		);
	} catch {
		console.log("📖 No members.json found (starting fresh)");
	}

	// 4. Convert member facts → SemanticFacts
	console.log("\n🔄 Converting member facts to semantic facts...");
	const semanticFacts: SemanticFact[] = [];
	const now = Date.now();

	for (const [memberName, facts] of Object.entries(memberMemory)) {
		for (const fact of facts) {
			const content = `${memberName}: ${fact.content}`;
			console.log(`  Embedding: "${content.slice(0, 80)}..."`);
			const embedding = await generateEmbedding(content);

			semanticFacts.push({
				id: `fact_mig_${now}_${Math.random().toString(36).slice(2, 8)}`,
				content: fact.content,
				category: "person",
				subject: memberName,
				context: `Migrated from member fact (key: ${fact.key})`,
				embedding,
				importance: 3, // Default importance for migrated member facts
				confidence: 0.8,
				createdAt: fact.updatedAt || now,
				lastConfirmed: fact.updatedAt || now,
			});

			// Rate limit: small delay between API calls
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	console.log(`  ✓ Converted ${semanticFacts.length} member facts`);

	// 5. Convert long-term entries → SemanticFacts
	console.log("\n🔄 Converting long-term entries to semantic facts...");
	let ltConverted = 0;
	let ltDeduped = 0;

	for (const entry of longTermEntries) {
		console.log(`  Embedding: "${entry.content.slice(0, 80)}..."`);
		const embedding = await generateEmbedding(entry.content);

		// Check for duplicates against already-added facts
		let isDuplicate = false;
		for (const existing of semanticFacts) {
			const similarity = cosineSimilarity(embedding, existing.embedding);
			if (similarity >= 0.85) {
				// Keep the higher-importance version
				if (entry.importance > existing.importance) {
					existing.content = entry.content;
					existing.context = entry.context;
					existing.importance = entry.importance;
					existing.embedding = embedding;
				}
				existing.lastConfirmed = Math.max(
					existing.lastConfirmed,
					entry.lastAccessed,
				);
				isDuplicate = true;
				ltDeduped++;
				console.log(`    ↳ Deduped (similarity=${similarity.toFixed(2)})`);
				break;
			}
		}

		if (!isDuplicate) {
			const category = inferCategory(entry.content);
			const subject =
				category === "person" ? inferSubject(entry.content) : undefined;

			semanticFacts.push({
				id: `fact_mig_${now}_${Math.random().toString(36).slice(2, 8)}`,
				content: entry.content,
				category,
				subject,
				context: entry.context,
				embedding,
				importance: entry.importance,
				confidence: 0.7,
				createdAt: entry.createdAt,
				lastConfirmed: entry.lastAccessed,
			});
			ltConverted++;
		}

		await new Promise((r) => setTimeout(r, 100));
	}
	console.log(`  ✓ Converted ${ltConverted} entries, deduped ${ltDeduped}`);

	// 6. Save semantic.json
	console.log(`\n💾 Saving semantic.json (${semanticFacts.length} facts)...`);
	await writeFile(
		"./memory/semantic.json",
		JSON.stringify(semanticFacts, null, 2),
	);
	console.log("  ✓ semantic.json saved");

	// 7. Convert short-term memories
	console.log("\n🔄 Converting short-term memories...");
	const shortTermDir = "./memory/short-term";

	if (existsSync(shortTermDir)) {
		const files = await readdir(shortTermDir);
		const jsonFiles = files.filter((f) => f.endsWith(".json"));

		for (const file of jsonFiles) {
			const chatIdStr = file.replace(".json", "");
			if (chatIdStr === "x") continue; // Skip placeholder files

			console.log(`  Processing chat ${chatIdStr}...`);

			try {
				const data = await readFile(`${shortTermDir}/${file}`, "utf-8");
				const oldMemory = JSON.parse(data) as OldShortTermMemory;

				// Create sensory buffer (last 10 messages)
				const sensoryBuffer: SensoryBuffer = {
					chatId: oldMemory.chatId,
					messages: oldMemory.messages.slice(-10),
					lastActivity: oldMemory.lastActivity,
					messageCountSincePromotion: 0,
					lastImageDate: oldMemory.lastImageDate,
					imageTargetTime: oldMemory.imageTargetTime,
					imageTargetDate: oldMemory.imageTargetDate,
				};

				await writeFile(
					`./memory/sensory/${chatIdStr}.json`,
					JSON.stringify(sensoryBuffer, null, 2),
				);
				console.log(
					`    ✓ Sensory buffer: ${sensoryBuffer.messages.length} messages`,
				);

				// Convert previousSummary to episode (if exists)
				const workingMemory: WorkingMemory = {
					chatId: oldMemory.chatId,
					episodes: [],
				};

				if (oldMemory.previousSummary) {
					console.log(`    Embedding previous summary for episode...`);
					const embedding = await generateEmbedding(oldMemory.previousSummary);
					workingMemory.episodes.push({
						id: `ep_mig_${now}_${Math.random().toString(36).slice(2, 8)}`,
						summary: oldMemory.previousSummary,
						participants: [
							...new Set(
								oldMemory.messages
									.map((m) => m.name)
									.filter((n): n is string => !!n),
							),
						],
						timestamp: oldMemory.lastActivity,
						importance: 3,
						embedding,
					});
					console.log(`    ✓ Episode created from previousSummary`);
					await new Promise((r) => setTimeout(r, 100));
				}

				await writeFile(
					`./memory/episodes/${chatIdStr}.json`,
					JSON.stringify(workingMemory, null, 2),
				);
			} catch (error) {
				console.error(`    ✗ Error processing ${file}:`, error);
			}
		}
	} else {
		console.log("  No short-term directory found");
	}

	// 8. Summary
	console.log("\n=== Migration Complete ===");
	console.log(`Semantic facts: ${semanticFacts.length}`);
	console.log(
		`  - From member facts: ${Object.values(memberMemory).reduce((s, f) => s + f.length, 0)}`,
	);
	console.log(`  - From long-term: ${ltConverted} (${ltDeduped} deduped)`);
	console.log("\nNew files:");
	console.log("  memory/semantic.json");
	console.log("  memory/sensory/*.json");
	console.log("  memory/episodes/*.json");
	console.log("\nBackups:");
	console.log("  memory/long-term.backup.json");
	console.log("  memory/members.backup.json");
	console.log("\n✅ You can now start the bot with: bun run dev");
}

migrate().catch((error) => {
	console.error("\n❌ Migration failed:", error);
	process.exit(1);
});
