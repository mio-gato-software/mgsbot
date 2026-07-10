import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { log } from "./logger.ts";
import { normalizeName } from "./memory/queries.ts";
import { unwrapVersioned, wrapVersioned } from "./memory/versioning.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const IDENTITIES_PATH = "./memory/identities.json";

export interface PersonIdentity {
	userId: number;
	canonicalName: string;
	aliases: string[]; // All known normalized name variants
	username?: string;
	lastSeen: number;
}

export type IdentityStore = Record<string, PersonIdentity>;

let identityCache: IdentityStore | null = null;

async function loadIdentities(): Promise<IdentityStore> {
	if (identityCache) return identityCache;
	try {
		const data = await readFile(IDENTITIES_PATH, "utf-8");
		identityCache = unwrapVersioned<IdentityStore>(JSON.parse(data));
		return identityCache;
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[identities] Error loading identities.json:", err);
		}
		identityCache = {};
		return {};
	}
}

async function saveIdentities(store: IdentityStore): Promise<void> {
	identityCache = store;
	await atomicWriteFile(
		IDENTITIES_PATH,
		JSON.stringify(wrapVersioned(store), null, 2),
	);
}

export async function initIdentities(): Promise<void> {
	if (!existsSync(IDENTITIES_PATH)) {
		await writeFile(
			IDENTITIES_PATH,
			JSON.stringify(wrapVersioned({}), null, 2),
		);
	}
}

/**
 * Register or update an identity on every message.
 * If the display name changed, the old normalized name is added to aliases.
 * Returns the canonical name for this user.
 */
export function applyIdentityUpdate(
	store: IdentityStore,
	userId: number,
	displayName: string,
	username?: string,
	now = Date.now(),
): string {
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
		existing.lastSeen = now;
		return existing.canonicalName;
	}

	// New identity
	store[key] = {
		userId,
		canonicalName: displayName,
		aliases: [normalized],
		username,
		lastSeen: now,
	};

	log.debug(`[identities] Registered new identity: ${displayName} (${userId})`);
	return displayName;
}

export async function registerIdentity(
	userId: number,
	displayName: string,
	username?: string,
): Promise<string> {
	const store = await loadIdentities();
	const canonical = applyIdentityUpdate(store, userId, displayName, username);
	await saveIdentities(store);
	return canonical;
}

/**
 * Given an LLM-extracted subject name, find the best matching canonical name.
 * Checks: exact alias match, then prefix match (e.g., "Juan" matches "Juan Pérez").
 * Falls back to raw name if no match.
 */
export function resolveCanonicalNameInStore(
	store: IdentityStore,
	rawName: string,
): string {
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

export async function resolveCanonicalName(rawName: string): Promise<string> {
	const store = await loadIdentities();
	return resolveCanonicalNameInStore(store, rawName);
}

/**
 * Returns all normalized aliases for a given canonical name.
 * Used by getFactsForSubjects() to expand search.
 */
export function getAliasesForCanonicalInStore(
	store: IdentityStore,
	canonicalName: string,
): string[] {
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

export async function getAllAliasesForCanonical(
	canonicalName: string,
): Promise<string[]> {
	const store = await loadIdentities();
	return getAliasesForCanonicalInStore(store, canonicalName);
}

export function findMentionedCanonicalNamesInStore(
	store: IdentityStore,
	text: string,
): string[] {
	const normalizedText = ` ${normalizeName(text).replace(/[^\p{L}\p{N}_@]+/gu, " ")} `;
	const mentioned = new Set<string>();

	for (const identity of Object.values(store)) {
		const namesToCheck = [
			identity.canonicalName,
			identity.username,
			identity.username ? `@${identity.username}` : undefined,
			...identity.aliases,
		].filter((name): name is string => !!name);

		for (const name of namesToCheck) {
			const normalized = normalizeName(name)
				.replace(/[^\p{L}\p{N}_@]+/gu, " ")
				.trim();
			if (normalized.length < 3) continue;
			if (normalizedText.includes(` ${normalized} `)) {
				mentioned.add(identity.canonicalName);
				break;
			}
		}
	}

	return [...mentioned];
}

export async function findMentionedCanonicalNames(
	text: string,
): Promise<string[]> {
	const store = await loadIdentities();
	return findMentionedCanonicalNamesInStore(store, text);
}
