import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";
import { unwrapVersioned, wrapVersioned } from "./versioning.ts";

export class StoreReadError extends Error {
	constructor(
		public readonly path: string,
		cause: unknown,
	) {
		super(
			`Cannot read memory store ${path}; original preserved. Restore a verified backup or repair the file before retrying.`,
			{ cause },
		);
	}
}

/** Missing files are first-run state. All other failures must stop a write. */
export async function readStore<T>(
	path: string,
	schema: z.ZodType<T>,
	fallback: () => T,
): Promise<T> {
	try {
		return schema.parse(
			unwrapVersioned(JSON.parse(await readFile(path, "utf8"))),
		);
	} catch (error) {
		if (isFileNotFound(error)) return fallback();
		throw new StoreReadError(path, error);
	}
}

export async function writeStore<T>(
	path: string,
	value: T,
	schema: z.ZodType<T>,
	wrapped = false,
): Promise<void> {
	// Protect even direct saves from overwriting a damaged or newer store.
	await readStore(path, schema, () => value);
	const validated = schema.parse(value);
	await atomicWriteFile(
		path,
		JSON.stringify(wrapped ? wrapVersioned(validated) : validated, null, 2),
	);
}
