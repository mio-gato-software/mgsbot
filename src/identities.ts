import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { normalizeName } from "./memory.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const IDENTITIES_PATH = "./memory/identities.json";
const isDev = process.env.NODE_ENV === "development";

export interface PersonIdentity {
	userId: number;
	canonicalName: string;
	aliases: string[]; // All known normalized name variants
	username?: string;
	lastSeen: number;
}

type IdentityStore = Record<string, PersonIdentity>;

let identityCache: IdentityStore | null = null;

async function loadIdentities(): Promise<IdentityStore> {
	if (identityCache) return identityCache;
	try {
		const data = await readFile(IDENTITIES_PATH, "utf-8");
		identityCache = JSON.parse(data) as IdentityStore;
		return identityCache;
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[identities] Error loading identities.json:", err);
		}
		identityCache = {};
		return {};
	}
}

async function saveIdentities(store: IdentityStore): Promise<void> {
	identityCache = store;
	await atomicWriteFile(IDENTITIES_PATH, JSON.stringify(store, null, 2));
}

export async function initIdentities(): Promise<void> {
	if (!existsSync(IDENTITIES_PATH)) {
		await writeFile(IDENTITIES_PATH, "{}");
	}
}

/**
 * Register or update an identity on every message.
 * If the display name changed, the old normalized name is added to aliases.
 * Returns the canonical name for this user.
 */
export async function registerIdentity(
	userId: number,
	displayName: string,
	username?: string,
): Promise<string> {
	const store = await loadIdentities();
	const key = String(userId);
	const normalized = normalizeName(displayName);

	const existing = store[key];
	if (existing) {
		// Name changed — add old normalized name to aliases if not already there
		const oldNormalized = normalizeName(existing.canonicalName);
		if (
			oldNormalized !== normalized &&
			!existing.aliases.includes(oldNormalized)
		) {
			existing.aliases.push(oldNormalized);
		}
		// Also ensure the new normalized name is in aliases
		if (!existing.aliases.includes(normalized)) {
			existing.aliases.push(normalized);
		}
		existing.canonicalName = displayName;
		if (username) existing.username = username;
		existing.lastSeen = Date.now();
		await saveIdentities(store);
		return existing.canonicalName;
	}

	// New identity
	store[key] = {
		userId,
		canonicalName: displayName,
		aliases: [normalized],
		username,
		lastSeen: Date.now(),
	};
	await saveIdentities(store);

	if (isDev)
		console.log(
			`[identities] Registered new identity: ${displayName} (${userId})`,
		);
	return displayName;
}

/**
 * Given an LLM-extracted subject name, find the best matching canonical name.
 * Checks: exact alias match, then prefix match (e.g., "Juan" matches "Juan Pérez").
 * Falls back to raw name if no match.
 */
export async function resolveCanonicalName(rawName: string): Promise<string> {
	const store = await loadIdentities();
	const normalized = normalizeName(rawName);

	// Exact alias match
	for (const identity of Object.values(store)) {
		if (identity.aliases.includes(normalized)) {
			return identity.canonicalName;
		}
	}

	// Prefix match: "eliaquin" should match identity with alias "eliaquin encarnacion"
	for (const identity of Object.values(store)) {
		for (const alias of identity.aliases) {
			if (alias.startsWith(normalized) || normalized.startsWith(alias)) {
				return identity.canonicalName;
			}
		}
	}

	return rawName;
}

/**
 * Returns all normalized aliases for a given canonical name.
 * Used by getFactsForSubjects() to expand search.
 */
export async function getAllAliasesForCanonical(
	canonicalName: string,
): Promise<string[]> {
	const store = await loadIdentities();
	const normalized = normalizeName(canonicalName);

	for (const identity of Object.values(store)) {
		if (
			identity.aliases.includes(normalized) ||
			normalizeName(identity.canonicalName) === normalized
		) {
			return identity.aliases;
		}
	}

	return [normalized];
}
