import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write a file atomically: write to a .tmp file first, then rename.
 * Prevents data loss from truncated writes on crash.
 */
export async function atomicWriteFile(
	filePath: string,
	data: string,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	await writeFile(tmpPath, data);
	await rename(tmpPath, filePath);
}

/**
 * Synchronous version of atomicWriteFile.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, data);
	renameSync(tmpPath, filePath);
}

/**
 * Retry a function on 429 (rate limit) or 503 (service unavailable) errors.
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
			const isRetryable = message.includes("429") || message.includes("503");
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
