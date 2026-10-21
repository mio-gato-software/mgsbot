import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { Api } from "grammy";
import { botNow, getDateString, getWeekStart } from "../src/bot-time.ts";
import {
	type GroupNewsDependencies,
	GroupNewsService,
	groupNewsSchema,
	isFreshGroupStory,
	scheduleGroupNews,
} from "../src/group-news.ts";
import {
	claimGroupContinuationSlot,
	resetGroupState,
} from "../src/group-state.ts";
import { loadSensory } from "../src/memory/sensory.ts";
import { readStore, writeStore } from "../src/memory/storage.ts";
import { memoryPath } from "../src/runtime-paths.ts";
import { atomicWriteFile } from "../src/utils.ts";

const chatId = -987654321;
const originalGroup = process.env.ALLOWED_GROUP_ID;
const path = memoryPath("group-news", `${chatId}.json`);
const sensory = memoryPath("sensory", `${chatId}.json`);
const now = botNow().hour(12).minute(0).second(0).valueOf();
const source = {
	published: new Date(now - 3_600_000).toISOString(),
	title: "A new telescope",
	text: "A telescope launched today",
	url: "https://example.org/telescope",
};
let searches = 0;
let sends = 0;
let learns = 0;
let compositions = 0;
async function setup(overrides: Partial<GroupNewsDependencies> = {}) {
	process.env.ALLOWED_GROUP_ID = String(chatId);
	searches = sends = learns = compositions = 0;
	resetGroupState();
	await atomicWriteFile(
		sensory,
		JSON.stringify({
			chatId,
			messages: [{ role: "user", content: "space", timestamp: now - 3600000 }],
			lastActivity: now - 3600000,
			messageCountSincePromotion: 0,
		}),
	);
	await writeStore(
		path,
		groupNewsSchema.parse({ week: getWeekStart(now), dueAt: now - 1 }),
		groupNewsSchema,
		true,
	);
	const deps: GroupNewsDependencies = {
		now: () => now,
		enabled: () => true,
		learn: async () => {
			learns++;
			return ["astronomy"];
		},
		search: async () => {
			searches++;
			return [source];
		},
		compose: async () => {
			compositions++;
			return "Esto está interesante, ¿qué les parece?";
		},
		...overrides,
	};
	const api = {
		sendMessage: async () => {
			sends++;
			return { message_id: 42 };
		},
	} as unknown as Api;
	return { deps, api, service: new GroupNewsService(deps) };
}
async function state() {
	return readStore(path, groupNewsSchema, () => {
		throw new Error("missing state");
	});
}
afterEach(async () => {
	if (originalGroup === undefined) delete process.env.ALLOWED_GROUP_ID;
	else process.env.ALLOWED_GROUP_ID = originalGroup;
	await rm(path, { force: true });
	await rm(sensory, { force: true });
	resetGroupState();
});

describe("group news", () => {
	test("random slot is in the remaining daytime week, including late starts", () => {
		for (const random of [0, 0.5, 0.99999]) {
			const time = scheduleGroupNews(now, () => random);
			expect(time).toBeGreaterThan(now);
			expect(getWeekStart(time)).toBe(getWeekStart(now));
			expect(botNow(time).hour()).toBeGreaterThanOrEqual(8);
			expect(botNow(time).hour()).toBeLessThan(21);
		}
	});
	test("research and send survive restart without duplicates; replies can continue", async () => {
		const { service, api, deps } = await setup();
		await Promise.all([
			service.tick(
				api,
				() => false,
				() => false,
			),
			service.tick(
				api,
				() => false,
				() => false,
			),
		]);
		await new GroupNewsService(deps).tick(
			api,
			() => false,
			() => false,
		);
		expect([learns, searches, sends]).toEqual([1, 1, 1]);
		expect((await state()).recent[0]?.url).toBe(source.url);
		expect((await loadSensory(chatId)).messages.at(-1)?.content).toContain(
			source.url,
		);
		expect(claimGroupContinuationSlot(chatId, now)).toBe(true);
	});
	test("disabled, off, sleeping and non-group targets do no work", async () => {
		const { service, api, deps } = await setup();
		await service.tick(
			api,
			() => true,
			() => false,
		);
		await service.tick(
			api,
			() => false,
			() => true,
		);
		await new GroupNewsService({ ...deps, enabled: () => false }).tick(
			api,
			() => false,
			() => false,
		);
		process.env.ALLOWED_GROUP_ID = "123";
		await service.tick(
			api,
			() => false,
			() => false,
		);
		expect([learns, searches, sends]).toEqual([0, 0, 0]);
	});
	test("research failures are reserved across restarts", async () => {
		const { service, api, deps } = await setup({
			search: async () => {
				searches++;
				throw new Error("offline");
			},
		});
		await expect(
			service.tick(
				api,
				() => false,
				() => false,
			),
		).rejects.toThrow("offline");
		await new GroupNewsService(deps).tick(
			api,
			() => false,
			() => false,
		);
		expect(searches).toBe(1);
		expect(sends).toBe(0);
	});
	test("empty interests never search or invent a topic", async () => {
		const { service, api } = await setup({ learn: async () => [] });
		await service.tick(
			api,
			() => false,
			() => false,
		);
		expect(searches).toBe(0);
		expect(sends).toBe(0);
	});
	test("active group is deferred even if it becomes active during generation", async () => {
		const { service, api } = await setup({
			compose: async () => {
				await atomicWriteFile(
					sensory,
					JSON.stringify({
						chatId,
						messages: [],
						lastActivity: now,
						messageCountSincePromotion: 0,
					}),
				);
				return "Interesting news";
			},
		});
		await service.tick(
			api,
			() => false,
			() => false,
		);
		expect(sends).toBe(0);
		expect((await state()).attemptedWeek).toBe("");
	});
	test("stale and already shared sources cannot be posted", async () => {
		const { service, api } = await setup();
		const saved = await state();
		saved.researchDay = getDateString(now);
		saved.lastDeliveryResearchAt = now;
		saved.stories = [{ source, fetchedAt: now - 3 * 86400000 }];
		await writeStore(path, saved, groupNewsSchema, true);
		await service.tick(
			api,
			() => false,
			() => false,
		);
		saved.stories = [{ source, fetchedAt: now }];
		saved.recent = [
			{ url: source.url, title: source.title, sentAt: now - 86400000 },
		];
		await writeStore(path, saved, groupNewsSchema, true);
		await service.tick(
			api,
			() => false,
			() => false,
		);
		expect(sends).toBe(0);
		expect(compositions).toBe(0);
	});
	test("ambiguous Telegram failure does not retry the send", async () => {
		const { service, deps } = await setup();
		const api = {
			sendMessage: async () => {
				sends++;
				throw new Error("timeout");
			},
		} as unknown as Api;
		await expect(
			service.tick(
				api,
				() => false,
				() => false,
			),
		).rejects.toThrow("timeout");
		await new GroupNewsService(deps).tick(
			api,
			() => false,
			() => false,
		);
		expect(sends).toBe(1);
	});
	test("silence and invalid output are throttled", async () => {
		const { service, api } = await setup({
			compose: async () => {
				compositions++;
				return "[SILENCE]";
			},
		});
		await service.tick(
			api,
			() => false,
			() => false,
		);
		await service.tick(
			api,
			() => false,
			() => false,
		);
		expect(sends).toBe(0);
		expect(compositions).toBe(1);
	});
});

test("freshness follows publication time, including relative age anchored at fetch", () => {
	expect(isFreshGroupStory(source, now, now)).toBe(true);
	expect(
		isFreshGroupStory(
			{ ...source, published: source.published.replace("Z", "") },
			now,
			now,
		),
	).toBe(true);
	for (const published of [
		undefined,
		"unknown",
		"2020-01-01T12:00:00Z",
		new Date(now + 3600000).toISOString(),
		"2 days ago",
	]) {
		expect(isFreshGroupStory({ ...source, published }, now, now)).toBe(false);
	}
	expect(
		isFreshGroupStory(
			{ ...source, published: "20 hours ago" },
			now - 5 * 3600000,
			now,
		),
	).toBe(false);
	expect(
		isFreshGroupStory(
			{ ...source, published: "2 hours ago" },
			now - 3600000,
			now,
		),
	).toBe(true);
});
