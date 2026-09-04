import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	cp,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getDateString } from "./bot-time.ts";
import { log } from "./logger.ts";
import { withPersistenceLock } from "./persistence-coordination.ts";
import { MEMORY_DIR, memoryPath } from "./runtime-paths.ts";
import { atomicWriteFile } from "./utils.ts";

export const BACKUPS_DIR = memoryPath("backups");
const RETENTION_DAYS = 7;
const BACKUP_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST = ".complete.json";
const EXCLUDED_FILES = new Set(["embedding-cache.json", MANIFEST]);
const inProgress = new Map<string, Promise<void>>();

type Manifest = Record<string, string>;
async function manifestFor(root: string, relative = ""): Promise<Manifest> {
	const result: Manifest = {};
	for (const entry of await readdir(join(root, relative), {
		withFileTypes: true,
	})) {
		if (entry.name === MANIFEST) continue;
		const path = join(relative, entry.name);
		if (entry.isDirectory())
			Object.assign(result, await manifestFor(root, path));
		else if (entry.isFile())
			result[path] = createHash("sha256")
				.update(await readFile(join(root, path)))
				.digest("hex");
		else if (entry.isSymbolicLink())
			result[path] = createHash("sha256")
				.update(`symlink:${await readlink(join(root, path))}`)
				.digest("hex");
		else throw new Error(`Unsupported backup entry: ${path}`);
	}
	return result;
}

export async function verifyMemoryBackup(path: string): Promise<boolean> {
	try {
		const manifest = JSON.parse(await readFile(join(path, MANIFEST), "utf8"));
		if (
			manifest.version !== 1 ||
			!manifest.files ||
			typeof manifest.files !== "object"
		)
			return false;
		const actual = await manifestFor(path);
		return (
			Object.keys(actual).length === Object.keys(manifest.files).length &&
			Object.entries(actual).every(
				([file, hash]) => manifest.files[file] === hash,
			)
		);
	} catch {
		return false;
	}
}

export interface BackupOptions {
	memoryDir?: string;
	backupsDir?: string;
	date?: string;
	copy?: typeof cp;
}

/** Only a verified staging copy is published as the completed daily snapshot. */
export async function runMemoryBackup(
	options: BackupOptions = {},
): Promise<void> {
	const source = resolve(options.memoryDir ?? MEMORY_DIR);
	const backups = resolve(options.backupsDir ?? join(source, "backups"));
	if (source === backups)
		throw new Error("Backups must use a separate directory");
	const running = inProgress.get(backups);
	if (running) return running;
	const task = snapshot(source, backups, options).finally(() =>
		inProgress.delete(backups),
	);
	inProgress.set(backups, task);
	return task;
}

async function snapshot(
	source: string,
	backups: string,
	options: BackupOptions,
): Promise<void> {
	const date = options.date ?? getDateString();
	if (!BACKUP_DATE_REGEX.test(date)) throw new Error("Invalid backup date");
	const dest = join(backups, date);
	if (await verifyMemoryBackup(dest)) return;
	const staging = join(backups, `.${date}.${randomUUID()}.tmp`);
	await mkdir(staging, { recursive: true });
	try {
		await withPersistenceLock(async () => {
			for (const entry of await readdir(source)) {
				if (
					entry === "backups" ||
					EXCLUDED_FILES.has(entry) ||
					entry.endsWith(".tmp")
				)
					continue;
				await (options.copy ?? cp)(join(source, entry), join(staging, entry), {
					recursive: true,
					filter: (path) =>
						!EXCLUDED_FILES.has(basename(path)) &&
						!path.endsWith(".tmp") &&
						resolve(path) !== backups,
				});
			}
		});
		await atomicWriteFile(
			join(staging, MANIFEST),
			JSON.stringify({ version: 1, files: await manifestFor(staging) }),
		);
		if (!(await verifyMemoryBackup(staging)))
			throw new Error("Backup verification failed");
		// Preserve legacy/incomplete copies for inspection instead of trusting or deleting them.
		if (existsSync(dest))
			await rename(dest, join(backups, `.${date}.incomplete.${randomUUID()}`));
		await rename(staging, dest);
		log.info(`[backup] Verified memory snapshot: ${dest}`);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	const snapshots = (await readdir(backups))
		.filter((entry) => BACKUP_DATE_REGEX.test(entry))
		.sort();
	for (const stale of snapshots.slice(
		0,
		Math.max(0, snapshots.length - RETENTION_DAYS),
	)) {
		await rm(join(backups, stale), { recursive: true, force: true });
	}
}
