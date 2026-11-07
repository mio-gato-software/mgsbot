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
import {
	abortable,
	abortableDelay,
	currentOperationSignal,
	isTimeoutError,
	ownsRetryBudget,
	withRetryBudget,
} from "./operation-deadline.ts";
import { withPersistenceLock } from "./persistence-coordination.ts";

/** Bound UTF-16 length without cutting a supplementary Unicode character in half. */
export function truncateText(text: string, maxChars: number): string {
	const end = Math.min(text.length, Math.max(0, Math.trunc(maxChars)));
	const last = text.charCodeAt(end - 1);
	const next = text.charCodeAt(end);
	const splitsSurrogatePair =
		last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
	return text.slice(0, splitsSurrogatePair ? end - 1 : end);
}

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
 * Retry transient HTTP failures and timeouts within the shared retry budget.
 * Providers can expose a numeric status; legacy errors retain 429/503 handling.
 * Uses exponential backoff.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	maxAttempts = 3,
	baseDelayMs = 1000,
): Promise<T> {
	if (ownsRetryBudget()) {
		currentOperationSignal()?.throwIfAborted();
		return abortable(Promise.resolve().then(fn), currentOperationSignal());
	}
	return withRetryBudget(async () => {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				currentOperationSignal()?.throwIfAborted();
				return await abortable(
					Promise.resolve().then(fn),
					currentOperationSignal(),
				);
			} catch (error) {
				currentOperationSignal()?.throwIfAborted();
				if (attempt === maxAttempts) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const isTimeout = isTimeoutError(error);
				const status =
					error instanceof Error &&
					"status" in error &&
					typeof error.status === "number"
						? error.status
						: undefined;
				const isRetryable =
					isTimeout ||
					(status !== undefined
						? [429, 500, 502, 503, 504].includes(status)
						: message.includes("429") || message.includes("503"));
				if (!isRetryable) throw error;
				const delay = baseDelayMs * 2 ** (attempt - 1);
				await abortableDelay(delay);
			}
		}
		throw new Error("withRetry: unreachable");
	});
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
