import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { COMMITMENTS_VERSION, stateSchema } from "../src/commitments/schema.ts";
import {
	chaptersSchema,
	checkInsSchema,
	episodesSchema,
	factsSchema,
	followUpsSchema,
	identitiesSchema,
	relationshipSchema,
	sensorySchema,
} from "../src/memory/schemas.ts";
import { readStore } from "../src/memory/storage.ts";
import { verifyMemoryBackup } from "../src/memory-backup.ts";

const stores = new Map<string, { schema: z.ZodType; version?: number }>([
	["semantic.json", { schema: factsSchema }],
	["identities.json", { schema: identitiesSchema }],
	["follow-ups.json", { schema: followUpsSchema }],
	["check-ins.json", { schema: checkInsSchema }],
	["commitments.json", { schema: stateSchema, version: COMMITMENTS_VERSION }],
]);
const chatStores = new Map<string, z.ZodType>([
	["sensory", sensorySchema],
	["episodes", episodesSchema],
	["relationships", relationshipSchema],
	["chapters", chaptersSchema],
]);

export async function verifyRestoredMemoryBackup(
	directory: string,
): Promise<number> {
	if (!(await verifyMemoryBackup(directory)))
		throw new Error("Snapshot manifest verification failed");

	let checked = 0;
	const checkStore = async (
		path: string,
		category: string,
		schema: z.ZodType,
		version?: number,
	) => {
		try {
			await readStore(
				path,
				schema,
				() => {
					throw new Error("Missing store");
				},
				version,
			);
			checked++;
		} catch {
			throw new Error(`Invalid memory store in ${category}`);
		}
	};

	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const store = stores.get(entry.name);
		if (store) {
			if (!entry.isFile())
				throw new Error(`Invalid memory store in ${entry.name}`);
			await checkStore(path, entry.name, store.schema, store.version);
		}
		const schema = chatStores.get(entry.name);
		if (schema) {
			if (!entry.isDirectory())
				throw new Error(`Invalid memory directory ${entry.name}`);
			for (const file of await readdir(path, { withFileTypes: true })) {
				if (!file.name.endsWith(".json")) continue;
				if (!file.isFile())
					throw new Error(`Invalid memory store in ${entry.name}`);
				await checkStore(join(path, file.name), entry.name, schema);
			}
		}
	}

	if (checked === 0)
		throw new Error("Snapshot contains no recognized memory stores");
	return checked;
}

if (import.meta.main) {
	const [directory] = process.argv.slice(2);
	try {
		if (!directory)
			throw new Error("Usage: bun run backup:verify <restored-snapshot>");
		const checked = await verifyRestoredMemoryBackup(resolve(directory));
		console.log(`Verified snapshot manifest and ${checked} memory stores.`);
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "Snapshot verification failed",
		);
		process.exitCode = 1;
	}
}
