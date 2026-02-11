/**
 * One-time migration script to:
 * 1. Unify variant subject names in semantic.json (e.g., "Eliaquín" -> "Eliaquín Encarnación")
 * 2. Deduplicate near-identical facts after unification
 * 3. Seed memory/identities.json with known identities
 *
 * Run with: bun run scripts/merge-person-facts.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { cosineSimilarity } from "../src/embeddings.ts";
import { normalizeName } from "../src/memory.ts";
import type { SemanticFact } from "../src/types.ts";

const SEMANTIC_PATH = "./memory/semantic.json";
const IDENTITIES_PATH = "./memory/identities.json";

async function main() {
	// Load semantic store
	const data = await readFile(SEMANTIC_PATH, "utf-8");
	const facts = JSON.parse(data) as SemanticFact[];

	console.log(`Loaded ${facts.length} total facts`);

	// Find all person facts and group by normalized subject
	const personFacts = facts.filter((f) => f.category === "person" && f.subject);
	const normalizedGroups = new Map<string, string[]>();

	for (const fact of personFacts) {
		const subject = fact.subject as string;
		const normalized = normalizeName(subject);
		const existing = normalizedGroups.get(normalized) ?? [];
		if (!existing.includes(subject)) {
			existing.push(subject);
		}
		normalizedGroups.set(normalized, existing);
	}

	// Find subjects that share a normalized prefix (e.g., "eliaquin" is prefix of "eliaquin encarnacion")
	const allNormalized = [...normalizedGroups.keys()];
	const mergeMap = new Map<string, string>(); // normalized short -> normalized long (canonical)

	for (let i = 0; i < allNormalized.length; i++) {
		for (let j = i + 1; j < allNormalized.length; j++) {
			const a = allNormalized[i];
			const b = allNormalized[j];
			if (a.startsWith(b) || b.startsWith(a)) {
				// Merge shorter into longer
				const shorter = a.length < b.length ? a : b;
				const longer = a.length < b.length ? b : a;
				mergeMap.set(shorter, longer);
				console.log(`  Merge: "${shorter}" -> "${longer}"`);
			}
		}
	}

	// Determine canonical display name for each group (longest variant)
	const canonicalDisplayNames = new Map<string, string>();
	for (const [normalized, variants] of normalizedGroups) {
		const target = mergeMap.get(normalized) ?? normalized;
		const allVariants = [...variants, ...(normalizedGroups.get(target) ?? [])];
		const longest = allVariants.reduce((a, b) =>
			a.length >= b.length ? a : b,
		);
		canonicalDisplayNames.set(target, longest);
		if (normalized !== target) {
			canonicalDisplayNames.set(normalized, longest);
		}
	}

	// Apply merges: update subject to canonical display name
	let mergedCount = 0;
	for (const fact of facts) {
		if (fact.category === "person" && fact.subject) {
			const normalized = normalizeName(fact.subject);
			const target = mergeMap.get(normalized) ?? normalized;
			const canonical = canonicalDisplayNames.get(target);
			if (canonical && fact.subject !== canonical) {
				console.log(
					`  Subject: "${fact.subject}" -> "${canonical}" (fact: "${fact.content.slice(0, 60)}")`,
				);
				fact.subject = canonical;
				mergedCount++;
			}
		}
	}

	console.log(`\nMerged ${mergedCount} fact subjects`);

	// Deduplicate: after merging, check for near-identical facts with same subject
	const dedupThreshold = 0.8;
	const toRemove = new Set<number>();

	for (let i = 0; i < facts.length; i++) {
		if (toRemove.has(i)) continue;
		for (let j = i + 1; j < facts.length; j++) {
			if (toRemove.has(j)) continue;
			if (
				facts[i].category === "person" &&
				facts[j].category === "person" &&
				facts[i].subject &&
				facts[j].subject &&
				normalizeName(facts[i].subject as string) ===
					normalizeName(facts[j].subject as string)
			) {
				const sim = cosineSimilarity(facts[i].embedding, facts[j].embedding);
				if (sim >= dedupThreshold) {
					// Keep the one with higher importance, or more recent
					const keepI =
						facts[i].importance > facts[j].importance ||
						(facts[i].importance === facts[j].importance &&
							facts[i].lastConfirmed >= facts[j].lastConfirmed);
					const removeIdx = keepI ? j : i;
					toRemove.add(removeIdx);
					console.log(
						`  Dedup (sim=${sim.toFixed(2)}): removing "${facts[removeIdx].content.slice(0, 60)}"`,
					);
				}
			}
		}
	}

	const dedupedFacts = facts.filter((_, i) => !toRemove.has(i));
	console.log(`\nRemoved ${toRemove.size} duplicate facts`);
	console.log(`Final fact count: ${dedupedFacts.length}`);

	// Write updated semantic store
	await writeFile(SEMANTIC_PATH, JSON.stringify(dedupedFacts, null, 2));
	console.log(`\nSaved updated semantic.json`);

	// Seed identities.json from existing data
	// Build identity entries from unique canonical names
	const identities: Record<
		string,
		{
			userId: number;
			canonicalName: string;
			aliases: string[];
			lastSeen: number;
		}
	> = {};

	// Collect all known name variants per canonical
	const canonicalAliases = new Map<string, Set<string>>();
	for (const [normalized, target] of mergeMap) {
		const canonical = canonicalDisplayNames.get(target) ?? target;
		const aliases = canonicalAliases.get(canonical) ?? new Set<string>();
		aliases.add(normalized);
		aliases.add(target);
		canonicalAliases.set(canonical, aliases);
	}

	// Also add standalone subjects
	for (const [normalized, variants] of normalizedGroups) {
		if (!mergeMap.has(normalized)) {
			const canonical = canonicalDisplayNames.get(normalized) ?? variants[0];
			const aliases = canonicalAliases.get(canonical) ?? new Set<string>();
			aliases.add(normalized);
			canonicalAliases.set(canonical, aliases);
		}
	}

	// Try to load existing identities to preserve user IDs
	let existingIdentities: Record<string, unknown> = {};
	try {
		const existingData = await readFile(IDENTITIES_PATH, "utf-8");
		existingIdentities = JSON.parse(existingData);
	} catch {
		// No existing file, that's fine
	}

	// Write identities with placeholder user IDs (will be updated on first message)
	let placeholderId = -1;
	for (const [canonical, aliases] of canonicalAliases) {
		// Check if any existing identity matches
		let found = false;
		for (const [key, value] of Object.entries(existingIdentities)) {
			const existing = value as {
				canonicalName: string;
				aliases: string[];
				userId: number;
			};
			if (
				normalizeName(existing.canonicalName) === normalizeName(canonical) ||
				existing.aliases?.some((a: string) => aliases.has(a))
			) {
				identities[key] = {
					...existing,
					canonicalName: canonical,
					aliases: [...aliases],
					lastSeen: Date.now(),
				};
				found = true;
				break;
			}
		}

		if (!found) {
			// Use placeholder ID — will be replaced on first real message
			identities[String(placeholderId)] = {
				userId: placeholderId,
				canonicalName: canonical,
				aliases: [...aliases],
				lastSeen: Date.now(),
			};
			placeholderId--;
		}
	}

	await writeFile(IDENTITIES_PATH, JSON.stringify(identities, null, 2));
	console.log(
		`\nSeeded identities.json with ${Object.keys(identities).length} identities:`,
	);
	for (const identity of Object.values(identities)) {
		console.log(
			`  - ${identity.canonicalName} (aliases: ${identity.aliases.join(", ")})`,
		);
	}

	console.log("\nDone! Run `bun run dev` to verify.");
}

main().catch(console.error);
