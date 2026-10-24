import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readStore, writeStore } from "./memory/storage.ts";
import { memoryPath } from "./runtime-paths.ts";

const WINDOW = 31 * 86400000;
const schema = z.array(
	z.object({
		at: z.number().finite().nonnegative(),
		count: z.number().int().positive(),
	}),
);
export type WebQuota = "brave" | "browserbase-fetch" | "browserbase-session";
// Reserve 20% of the published free allowance. Sessions reserve their entire
// server-enforced 60-second lifetime, including failures and lost responses.
const limits: Record<WebQuota, number> = {
	brave: 800,
	"browserbase-fetch": 800,
	"browserbase-session": 48,
};
const tails = new Map<string, Promise<unknown>>();

/** Reserve before every outbound provider call; never refund ambiguous failures.
 * A rolling 31-day window also bounds every shorter provider billing month.
 * The filesystem lock fails closed across processes and after interrupted writes.
 */
export async function reserveWebQuota(
	provider: WebQuota,
	key: string,
	options: { directory?: string; now?: () => number; limit?: number } = {},
): Promise<void> {
	const directory =
		options.directory ?? process.env.WEB_QUOTA_DIR ?? memoryPath("web-quotas");
	const fingerprint = createHash("sha256")
		.update(key)
		.digest("hex")
		.slice(0, 24);
	const path = join(directory, `${provider}-${fingerprint}.json`);
	const prior = tails.get(path) ?? Promise.resolve();
	const work = prior
		.catch(() => {})
		.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			const lock = await open(`${path}.lock`, "wx", 0o600);
			try {
				const now = (options.now ?? Date.now)();
				const entries = (await readStore(path, schema, () => [])).filter(
					(e) => e.at > now - WINDOW,
				);
				const total = entries.reduce((n, e) => n + e.count, 0);
				if (total >= (options.limit ?? limits[provider]))
					throw new Error(
						`Local ${provider} rolling 31-day allowance exhausted`,
					);
				const day = Math.floor(now / 86400000) * 86400000;
				const entry = entries.find((e) => e.at === day + 86400000 - 1);
				if (entry) entry.count++;
				else entries.push({ at: day + 86400000 - 1, count: 1 });
				await writeStore(path, entries, schema, true);
			} finally {
				await lock.close();
				await unlink(`${path}.lock`);
			}
		});
	tails.set(path, work);
	try {
		await work;
	} finally {
		if (tails.get(path) === work) tails.delete(path);
	}
}
