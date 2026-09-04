import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { withPersistenceLock } from "./persistence-coordination.ts";

/**
 * Write a file atomically: write to a .tmp file first, then rename.
 * Prevents data loss from truncated writes on crash.
 */
export async function atomicWriteFile(
	filePath: string,
	data: string,
): Promise<void> {
	return withPersistenceLock(async () => {
		const dir = dirname(filePath);
		if (!existsSync(dir)) await mkdir(dir, { recursive: true });
		const tmpPath = `${filePath}.${randomUUID()}.tmp`;
		try {
			const file = await open(tmpPath, "wx", 0o600);
			try {
				await file.writeFile(data);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(tmpPath, filePath);
		} finally {
			await unlink(tmpPath).catch((error) => {
				if (!isFileNotFound(error)) throw error;
			});
		}
	});
}

/**
 * Synchronous version of atomicWriteFile.
 */
export function atomicWriteFileSync(
	filePath: string,
	data: string,
	mode?: number,
): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmpPath = `${filePath}.${randomUUID()}.tmp`;
	writeFileSync(tmpPath, data, mode !== undefined ? { mode } : undefined);
	renameSync(tmpPath, filePath);
	// rename preserves the temp file's mode, which may predate the mode option
	if (mode !== undefined) chmodSync(filePath, mode);
}

/**
 * Retry a function on 429 (rate limit), 503 (service unavailable), or timeout errors.
 * Uses exponential backoff.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	maxAttempts = 3,
	baseDelayMs = 1000,
): Promise<T> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt === maxAttempts) throw error;
			const message = error instanceof Error ? error.message : String(error);
			const isTimeout =
				(error instanceof DOMException && error.name === "TimeoutError") ||
				message.includes("timed out");
			const isRetryable =
				message.includes("429") || message.includes("503") || isTimeout;
			if (!isRetryable) throw error;
			const delay = baseDelayMs * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw new Error("withRetry: unreachable");
}

/**
 * Check if an error is a "file not found" (ENOENT) error.
 * Used to discriminate expected "file doesn't exist yet" from real errors.
 */
export function isFileNotFound(err: unknown): boolean {
	return (
		err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
	);
}

/**
 * Parse a .env file into a plain key/value map.
 * Handles surrounding single/double quotes, inline comments are NOT stripped.
 * Missing files return an empty object.
 */
export function parseEnvFile(path = "./.env"): Record<string, string> {
	if (!existsSync(path)) return {};
	const env: Record<string, string> = {};
	const content = readFileSync(path, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let value = trimmed.slice(eqIdx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

/**
 * Load a .env file into process.env (existing keys are overwritten).
 */
export function loadEnvIntoProcess(path = "./.env"): void {
	const env = parseEnvFile(path);
	for (const [key, value] of Object.entries(env)) {
		process.env[key] = value;
	}
}

const SAFE_MEDIA_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"ogg",
	"oga",
	"mp3",
	"m4a",
	"wav",
	"opus",
]);

/**
 * Normalize an extension coming from an untrusted source (Telegram file_path).
 * Returns only the last segment without path separators, lowercased and
 * constrained to ASCII alphanumerics. If missing or not in the safe list,
 * returns the provided fallback.
 */
export function safeMediaExtension(
	rawExt: string | undefined,
	fallback: "jpg" | "mp3" | "ogg",
): string {
	if (!rawExt) return fallback;
	const last = rawExt.split(/[\\/]/).pop() ?? "";
	const clean = last.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!clean) return fallback;
	return SAFE_MEDIA_EXTENSIONS.has(clean) ? clean : fallback;
}

/** Verbose dev logging gate (NODE_ENV=development). */
export const isDev = process.env.NODE_ENV === "development";
