import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsSchema } from "../src/memory/schemas.ts";
import {
	readStore,
	StoreReadError,
	writeStore,
} from "../src/memory/storage.ts";
import { MEMORY_DIR } from "../src/runtime-paths.ts";
import { atomicWriteFile } from "../src/utils.ts";

const dirs: string[] = [];
async function path() {
	const dir = await mkdtemp(join(tmpdir(), "mgs-store-"));
	dirs.push(dir);
	return join(dir, "facts.json");
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("storage recovery boundaries", () => {
	test("test configuration cannot point at repository runtime memory", () => {
		expect(MEMORY_DIR).not.toBe(join(process.cwd(), "memory"));
		expect(MEMORY_DIR).toContain("mgsbot-tests-");
	});
	test("missing files are valid first-run state", async () => {
		expect(await readStore(await path(), factsSchema, () => [])).toEqual([]);
	});
	for (const input of [
		"{broken",
		JSON.stringify({ schemaVersion: 999, data: [] }),
		JSON.stringify([{ id: "invalid-shape" }]),
	]) {
		test(`preserves an invalid store on read and direct save: ${input}`, async () => {
			const file = await path();
			await writeFile(file, input);
			await expect(
				readStore(file, factsSchema, () => []),
			).rejects.toBeInstanceOf(StoreReadError);
			await expect(
				writeStore(file, [], factsSchema, true),
			).rejects.toBeInstanceOf(StoreReadError);
			expect(await readFile(file, "utf8")).toBe(input);
		});
	}
	test("legacy data migrates to a validated v1 envelope", async () => {
		const file = await path();
		await writeFile(file, "[]");
		await writeStore(
			file,
			await readStore(file, factsSchema, () => []),
			factsSchema,
			true,
		);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			schemaVersion: 1,
			data: [],
		});
	});
	test("overlapping atomic writes publish complete files without temp collisions", async () => {
		const file = await path();
		const values = Array.from({ length: 12 }, (_, i) =>
			JSON.stringify({ i, payload: String(i).repeat(20000) }),
		);
		await Promise.all(values.map((value) => atomicWriteFile(file, value)));
		expect(values).toContain(await readFile(file, "utf8"));
	});
});
