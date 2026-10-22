import { expect, test } from "bun:test";
import { Bot } from "grammy";
import {
	cancelActiveOperations,
	currentOperationSignal,
	withDeadline,
} from "../src/operation-deadline.ts";
import { isRuntimeHealthy, RuntimeHealth } from "../src/runtime-health.ts";
import {
	registerUpdateProcessing,
	startBotRunner,
} from "../src/update-processing.ts";

function update(id: number, chat: number, text: string) {
	return {
		update_id: id,
		message: {
			message_id: id,
			date: 1,
			chat: { id: chat, type: "private" as const, first_name: "Test" },
			from: { id: chat, is_bot: false, first_name: "Test" },
			text,
		},
	};
}
function botFixture() {
	return new Bot("test-no-network", {
		botInfo: {
			id: 42,
			is_bot: true,
			first_name: "Bot",
			username: "test_bot",
			can_join_groups: true,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
			has_topics_enabled: false,
			allows_users_to_create_topics: false,
			can_manage_bots: false,
			supports_join_request_queries: false,
		},
	});
}

test("a hanging turn times out, reports failure, and releases the next command in the same chat", async () => {
	const bot = botFixture();
	const health = new RuntimeHealth();
	const replies: string[] = [];
	bot.api.config.use(async (_previous, method, payload) => {
		if (method === "sendMessage")
			replies.push((payload as { text: string }).text);
		return { ok: true, result: {} } as never;
	});
	registerUpdateProcessing(bot, health, 20);
	const events: string[] = [];
	let cancelled = false;
	bot.on("message:text", async (ctx) => {
		events.push(ctx.message.text);
		if (ctx.message.text === "slow") {
			currentOperationSignal()?.addEventListener("abort", () => {
				cancelled = true;
			});
			await new Promise<void>(() => {});
		}
	});
	await Promise.all([
		bot.handleUpdate(update(1, 100, "slow")),
		bot.handleUpdate(update(2, 100, "/on")),
	]);
	expect(events).toEqual(["slow", "/on"]);
	expect(cancelled).toBe(true);
	expect(replies).toHaveLength(1);
	expect(health.snapshot(0).oldestTurnStartedAt).toBeNull();
});

test("the production runner handles another chat while preserving order in a busy chat", async () => {
	const bot = botFixture();
	const health = new RuntimeHealth();
	const events: string[] = [];
	let finishSlow!: () => void;
	const slow = new Promise<void>((resolve) => {
		finishSlow = resolve;
	});
	let finishOther!: () => void;
	const other = new Promise<void>((resolve) => {
		finishOther = resolve;
	});
	let delivered = false;
	bot.api.config.use(async (_previous, method, _payload, signal) => {
		if (method !== "getUpdates") throw new Error("Unexpected network call");
		if (!delivered) {
			delivered = true;
			return {
				ok: true,
				result: [
					update(1, 100, "slow"),
					update(2, 100, "next"),
					update(3, 100, "next2"),
					update(4, 100, "next3"),
					update(5, 200, "/on"),
				],
			} as never;
		}
		return new Promise((resolve) => {
			if (signal?.aborted) resolve({ ok: true, result: [] } as never);
			else
				signal?.addEventListener(
					"abort",
					() => resolve({ ok: true, result: [] } as never),
					{ once: true },
				);
		});
	});
	registerUpdateProcessing(bot, health);
	bot.on("message:text", async (ctx) => {
		events.push(ctx.message.text);
		if (ctx.message.text === "slow") await slow;
		if (ctx.message.text === "/on") finishOther();
	});
	const runner = startBotRunner(bot, health);
	try {
		await withDeadline("test runner", 1000, () => other);
		expect(events).toEqual(["slow", "/on"]);
		finishSlow();
		await runner.stop();
		expect(events).toEqual(["slow", "/on", "next", "next2", "next3"]);
	} finally {
		finishSlow();
		await runner.stop();
	}
});

test("fresh heartbeat alone cannot conceal stalled polling or an overdue turn", () => {
	const health = new RuntimeHealth();
	const now = Date.now();
	health.polled(now - 121_000);
	expect(isRuntimeHealthy(health.snapshot(0, now), now)).toBe(false);
	health.polled(now);
	expect(isRuntimeHealthy(health.snapshot(0, now), now)).toBe(true);
	health.started(1, now - 400_000);
	expect(isRuntimeHealthy(health.snapshot(4, now), now)).toBe(false);
	health.completed(1, now);
	health.started(2, now);
	health.polled(now - 121_000);
	expect(isRuntimeHealthy(health.snapshot(4, now), now)).toBe(true);
});

test("Telegram polling rejections cannot refresh the successful-poll heartbeat", async () => {
	const bot = botFixture();
	const health = new RuntimeHealth();
	health.polled(Date.now() - 121_000);
	let rejected = true;
	bot.api.config.use(async () =>
		rejected
			? ({ ok: false, error_code: 503, description: "unavailable" } as never)
			: ({ ok: true, result: [] } as never),
	);
	registerUpdateProcessing(bot, health);
	await expect(bot.api.getUpdates({ timeout: 0 })).rejects.toThrow(
		"unavailable",
	);
	expect(isRuntimeHealthy(health.snapshot(0))).toBe(false);
	rejected = false;
	await bot.api.getUpdates({ timeout: 0 });
	expect(isRuntimeHealthy(health.snapshot(0))).toBe(true);
});

test("expired middleware cannot deliver a late reply after the timeout notice", async () => {
	const bot = botFixture();
	const health = new RuntimeHealth();
	const replies: string[] = [];
	bot.api.config.use(async (_previous, method, payload) => {
		if (method === "sendMessage")
			replies.push((payload as { text: string }).text);
		return { ok: true, result: {} } as never;
	});
	registerUpdateProcessing(bot, health, 10);
	bot.on("message:text", async (ctx) => {
		await Bun.sleep(30);
		await ctx.reply("late reply");
	});
	await bot.handleUpdate(update(1, 100, "slow"));
	await Bun.sleep(40);
	expect(replies).toHaveLength(1);
	expect(replies).not.toContain("late reply");
});

test("shutdown cancels active work and drains queued turns without starting them", async () => {
	const bot = botFixture();
	const health = new RuntimeHealth();
	registerUpdateProcessing(bot, health);
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const events: string[] = [];
	bot.on("message:text", async (ctx) => {
		events.push(ctx.message.text);
		started();
		await new Promise<void>(() => {});
	});
	const outcomes = Promise.allSettled([
		bot.handleUpdate(update(1, 100, "slow")),
		bot.handleUpdate(update(2, 100, "queued")),
	]);
	await ready;
	health.stopAccepting();
	cancelActiveOperations();
	await health.drain();
	await outcomes;
	expect(events).toEqual(["slow"]);
	expect(health.snapshot(0).oldestTurnStartedAt).toBeNull();
});
