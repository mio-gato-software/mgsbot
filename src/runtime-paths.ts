import { join, resolve } from "node:path";

// Resolved once at startup, after environment loading. Tests supply a disposable root.
export const MEMORY_DIR = resolve(process.env.MEMORY_DIR || "./memory");
export function memoryPath(...parts: string[]): string {
	return join(MEMORY_DIR, ...parts);
}
