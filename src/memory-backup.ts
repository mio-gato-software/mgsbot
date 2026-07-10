import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename } from "node:path";
import { getDateString } from "./bot-time.ts";
import { log } from "./logger.ts";

const MEMORY_DIR = "./memory";
export const BACKUPS_DIR = "./memory/backups";
const RETENTION_DAYS = 7;
const BACKUP_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Regenerable from the API; excluded to keep backups small.
const EXCLUDED_FILES = new Set(["embedding-cache.json"]);

/**
 * Snapshot memory/ into memory/backups/<YYYY-MM-DD>/ once per day and prune
 * snapshots older than the retention window. Atomic writes protect single
 * files from torn writes; this protects against accidental loss or a bad
 * migration wiping the irreplaceable accumulated memory.
 */
export async function runMemoryBackup(): Promise<void> {
	const today = getDateString();
	const dest = `${BACKUPS_DIR}/${today}`;
	if (existsSync(dest)) return;

	await mkdir(dest, { recursive: true });
	// Copy top-level entries individually: node's cp() refuses to copy a
	// directory into a subdirectory of itself, and backups/ lives inside memory/.
	const entries = await readdir(MEMORY_DIR);
	for (const entry of entries) {
		if (entry === "backups" || EXCLUDED_FILES.has(entry)) continue;
		await cp(`${MEMORY_DIR}/${entry}`, `${dest}/${entry}`, {
			recursive: true,
			filter: (src) => !EXCLUDED_FILES.has(basename(src)),
		});
	}
	log.debug(`[backup] Memory snapshot written to ${dest}`);

	await pruneOldBackups();
}

async function pruneOldBackups(): Promise<void> {
	const entries = await readdir(BACKUPS_DIR);
	const snapshots = entries.filter((e) => BACKUP_DATE_REGEX.test(e)).sort();
	const excess = snapshots.length - RETENTION_DAYS;
	for (const stale of snapshots.slice(0, Math.max(0, excess))) {
		await rm(`${BACKUPS_DIR}/${stale}`, { recursive: true, force: true });
		log.debug(`[backup] Pruned old snapshot ${stale}`);
	}
}
