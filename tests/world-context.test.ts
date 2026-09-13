import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { memoryPath } from "../src/runtime-paths.ts";
import type { WebSearchRequest } from "../src/web-search.ts";
import {
	WORLD_CONTEXT_TTL_MS,
	WorldContextService,
} from "../src/world-context.ts";

const HOUR = 60 * 60 * 1000;
async function fixture() {
	const directory = await mkdtemp(memoryPath("world-context-test-"));
	let now = Date.parse("2026-09-13T12:00:00Z");
	const requests: WebSearchRequest[] = [];
	const options = {
		directory,
		now: () => now,
		enabled: () => true,
		headlinesEnabled: () => true,
		newsQuery: () => "public headlines",
		dailyLimit: () => 30,
		search: async (request: WebSearchRequest) => {
			requests.push(request);
			return [
				{
					title: request.query,
					url: `https://example.com/${encodeURIComponent(request.query)}`,
					text: `Evidence for ${request.query}`,
				},
			];
		},
	};
	return {
		directory,
		requests,
		options,
		service: new WorldContextService(options),
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("unconfigured search omits all functionality, disk writes and network requests", async () => {
	const f = await fixture();
	const service = new WorldContextService({
		...f.options,
		enabled: () => false,
	});
	expect(await service.context(1)).toBe("");
	expect(await service.search(1, { query: "news" })).toContain("disabled");
	await service.refreshHeadlines();
	expect(f.requests).toHaveLength(0);
	expect(await readdir(f.directory)).toEqual([]);
});

test("cached queries survive restart, stay private to their chat, and do not renew expiry", async () => {
	const f = await fixture();
	await f.service.search(1, { query: "a public event", freshness: "pw" });
	f.advance(HOUR / 2);
	const restarted = new WorldContextService(f.options);
	expect(
		await restarted.search(1, { query: "A PUBLIC EVENT", freshness: "pw" }),
	).toContain("Reused");
	expect(f.requests).toHaveLength(1);
	expect(await restarted.context(2)).toBe("");
	expect(await restarted.context(1)).toContain("Evidence for a public event");
	f.advance(WORLD_CONTEXT_TTL_MS - HOUR / 2);
	expect(await restarted.context(1)).toBe("");
	const disk = JSON.parse(
		await readFile(join(f.directory, "chats/1.json"), "utf8"),
	);
	expect(disk.data.entries).toEqual([]);
});

test("lookups retain five topics, recheck after an hour and isolate freshness filters", async () => {
	const f = await fixture();
	for (let i = 0; i < 6; i++)
		await f.service.search(1, { query: `topic-${i}` });
	const context = await f.service.context(1);
	expect(context).not.toContain("topic-0");
	expect(context).toContain("topic-5");
	expect(context.length).toBeLessThanOrEqual(6000);
	f.advance(HOUR);
	await f.service.search(1, { query: "topic-5" });
	await f.service.search(1, { query: "topic-5", freshness: "pd" });
	expect(f.requests).toHaveLength(8);
});

test("concurrent identical requests share one lookup and persistent budget spans chats", async () => {
	const f = await fixture();
	f.options.dailyLimit = () => 2;
	await Promise.all([
		f.service.search(1, { query: "topic" }),
		f.service.search(1, { query: "topic" }),
	]);
	expect(f.requests).toHaveLength(1);
	await f.service.search(2, { query: "another topic" });
	const restarted = new WorldContextService(f.options);
	expect(await restarted.search(3, { query: "over budget" })).toContain(
		"could not be completed",
	);
	expect(f.requests).toHaveLength(2);
	f.advance(24 * HOUR);
	await restarted.search(3, { query: "new day" });
	expect(f.requests).toHaveLength(3);
});

test("headlines refresh once per active day across restarts and share the daily budget", async () => {
	const f = await fixture();
	await Promise.all([
		f.service.refreshHeadlines(),
		f.service.refreshHeadlines(),
	]);
	await new WorldContextService(f.options).refreshHeadlines();
	expect(f.requests).toEqual([
		{ query: "public headlines", news: true, freshness: "pd" },
	]);
	expect(await f.service.context(2)).toContain("public headlines");
	const onDemandOnly = new WorldContextService({
		...f.options,
		headlinesEnabled: () => false,
	});
	expect(await onDemandOnly.context(2)).toBe("");
	await onDemandOnly.refreshHeadlines();
	expect(f.requests).toHaveLength(1);
	f.advance(24 * HOUR);
	await f.service.refreshHeadlines();
	expect(f.requests).toHaveLength(2);
});

test("network failures count toward the budget and do not fabricate sources", async () => {
	const f = await fixture();
	let calls = 0;
	const options = {
		...f.options,
		dailyLimit: () => 1,
		search: async () => {
			calls++;
			throw new Error("secret transport details");
		},
	};
	const service = new WorldContextService(options);
	const result = await service.search(1, { query: "news" });
	expect(result).toContain("could not be completed");
	expect(result).not.toContain("secret");
	expect(await service.context(1)).toBe("");
	await new WorldContextService(options).search(2, { query: "another" });
	expect(calls).toBe(1);
});

test("failed headline refreshes back off for 24h, even after restart", async () => {
	const f = await fixture();
	let calls = 0;
	const options = {
		...f.options,
		search: async () => {
			calls++;
			throw new Error("offline");
		},
	};
	await new WorldContextService(options).refreshHeadlines();
	await new WorldContextService(options).refreshHeadlines();
	expect(calls).toBe(1);
	f.advance(24 * HOUR);
	await new WorldContextService(options).refreshHeadlines();
	expect(calls).toBe(2);
});

test("damaged cache or future schema is preserved and does not break the conversation", async () => {
	const f = await fixture();
	await f.service.search(1, { query: "original" });
	const file = join(f.directory, "chats/1.json");
	for (const content of ["{damaged", '{"schemaVersion":999,"data":{}}']) {
		await writeFile(file, content);
		expect(await f.service.context(1)).toBe("");
		expect(await f.service.search(1, { query: "replacement" })).toContain(
			"could not be completed",
		);
		expect(await readFile(file, "utf8")).toBe(content);
	}
	expect(f.requests).toHaveLength(1);
});
