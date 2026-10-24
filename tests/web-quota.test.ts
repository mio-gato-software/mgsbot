import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveWebQuota } from "../src/web-quota.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
	);
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "quota-"));
	roots.push(directory);
	return directory;
}
test("concurrent reservations and restart cannot exceed the rolling quota", async () => {
	const directory = await fixture();
	let now = Date.parse("2026-10-24T12:00Z");
	const options = { directory, now: () => now, limit: 3 };
	const results = await Promise.allSettled(
		Array.from({ length: 8 }, () =>
			reserveWebQuota("brave", "test-key", options),
		),
	);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
	await expect(reserveWebQuota("brave", "test-key", options)).rejects.toThrow(
		"allowance exhausted",
	);
	now += 30 * 86400000;
	await expect(reserveWebQuota("brave", "test-key", options)).rejects.toThrow();
	now += 2 * 86400000;
	await reserveWebQuota("brave", "test-key", options);
});
test("corrupt state and an interrupted process lock fail closed", async () => {
	const directory = await fixture();
	const key = "other-key";
	const path = join(
		directory,
		`brave-${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`,
	);
	await writeFile(path, "damaged");
	await expect(reserveWebQuota("brave", key, { directory })).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe("damaged");
	await rm(path);
	await writeFile(`${path}.lock`, "");
	await expect(reserveWebQuota("brave", key, { directory })).rejects.toThrow();
});
test("provider resources have independent budgets for the same account key", async () => {
	const directory = await fixture();
	const options = { directory, limit: 1 };
	await reserveWebQuota("browserbase-fetch", "key", options);
	await reserveWebQuota("browserbase-session", "key", options);
	await expect(
		reserveWebQuota("browserbase-fetch", "key", options),
	).rejects.toThrow();
});
