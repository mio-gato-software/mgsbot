import { afterEach, expect, test } from "bun:test";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsSchema } from "../src/memory/schemas.ts";
import { readStore } from "../src/memory/storage.ts";
import { runMemoryBackup, verifyMemoryBackup } from "../src/memory-backup.ts";

const dirs: string[] = [];
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mgs-backup-"));
	dirs.push(dir);
	await writeFile(join(dir, "semantic.json"), "[]");
	return dir;
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
test("failed copies never publish completion and can be retried", async () => {
	const memoryDir = await fixture();
	await expect(
		runMemoryBackup({
			memoryDir,
			date: "2040-01-01",
			copy: async () => {
				throw new Error("disk failure");
			},
		}),
	).rejects.toThrow("disk failure");
	expect(await verifyMemoryBackup(join(memoryDir, "backups/2040-01-01"))).toBe(
		false,
	);
	await runMemoryBackup({ memoryDir, date: "2040-01-01" });
	expect(await verifyMemoryBackup(join(memoryDir, "backups/2040-01-01"))).toBe(
		true,
	);
});
test("incomplete copies are replaced, temporary files excluded, restored data validates", async () => {
	const memoryDir = await fixture();
	const dest = join(memoryDir, "backups/2040-01-02");
	await mkdir(dest, { recursive: true });
	await writeFile(join(memoryDir, "semantic.failed.tmp"), "partial");
	await runMemoryBackup({ memoryDir, date: "2040-01-02" });
	expect(await readdir(dest)).not.toContain("semantic.failed.tmp");
	const restore = await fixture();
	await cp(dest, restore, { recursive: true });
	expect(
		await readStore(join(restore, "semantic.json"), factsSchema, () => []),
	).toEqual([]);
	await writeFile(join(dest, "semantic.json"), "corruption");
	expect(await verifyMemoryBackup(dest)).toBe(false);
});
test("verified daily backups are preserved and retention keeps seven completed snapshots", async () => {
	const memoryDir = await fixture();
	for (let day = 1; day <= 8; day++)
		await runMemoryBackup({
			memoryDir,
			date: `2040-01-${String(day).padStart(2, "0")}`,
		});
	const backups = await readdir(join(memoryDir, "backups"));
	expect(backups).toHaveLength(7);
	expect(backups).not.toContain("2040-01-01");
	await writeFile(join(memoryDir, "semantic.json"), "new state");
	await runMemoryBackup({ memoryDir, date: "2040-01-08" });
	expect(
		await readFile(join(memoryDir, "backups/2040-01-08/semantic.json"), "utf8"),
	).toBe("[]");
});

test("snapshot copying holds off asynchronous state writes until the copy completes", async () => {
	const { atomicWriteFile } = await import("../src/utils.ts");
	const memoryDir = await fixture();
	const copying = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const backup = runMemoryBackup({
		memoryDir,
		date: "2040-02-01",
		copy: async (...args) => {
			copying.resolve();
			await release.promise;
			await cp(...args);
		},
	});
	await copying.promise;
	let written = false;
	const write = atomicWriteFile(join(memoryDir, "semantic.json"), "[1]").then(
		() => {
			written = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(written).toBe(false);
	release.resolve();
	await Promise.all([backup, write]);
	expect(
		await readFile(join(memoryDir, "backups/2040-02-01/semantic.json"), "utf8"),
	).toBe("[]");
	expect(await readFile(join(memoryDir, "semantic.json"), "utf8")).toBe("[1]");
});
