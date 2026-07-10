import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { startChatAction, withChatAction } from "../src/chat-actions.ts";

function makeCtx(): { ctx: Context; actions: string[] } {
	const actions: string[] = [];
	const ctx = {
		replyWithChatAction: async (action: string) => {
			actions.push(action);
			return true;
		},
	} as unknown as Context;
	return { ctx, actions };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startChatAction", () => {
	test("sends the action immediately and refreshes on the interval", async () => {
		const { ctx, actions } = makeCtx();
		const handle = startChatAction(ctx, "typing", 10);
		await sleep(35);
		handle.stop();
		expect(actions.length).toBeGreaterThanOrEqual(3);
		expect(actions.every((a) => a === "typing")).toBe(true);
	});

	test("stop() halts refreshing", async () => {
		const { ctx, actions } = makeCtx();
		const handle = startChatAction(ctx, "typing", 10);
		handle.stop();
		const countAtStop = actions.length;
		await sleep(30);
		expect(actions.length).toBe(countAtStop);
	});

	test("stop() is idempotent", () => {
		const { ctx } = makeCtx();
		const handle = startChatAction(ctx, "typing", 10);
		handle.stop();
		expect(() => handle.stop()).not.toThrow();
	});

	test("update() switches the action and resends immediately", async () => {
		const { ctx, actions } = makeCtx();
		const handle = startChatAction(ctx, "typing", 1000);
		handle.update("record_voice");
		handle.stop();
		expect(actions).toEqual(["typing", "record_voice"]);
	});

	test("update() with the same action does not resend", () => {
		const { ctx, actions } = makeCtx();
		const handle = startChatAction(ctx, "typing", 1000);
		handle.update("typing");
		handle.stop();
		expect(actions).toEqual(["typing"]);
	});

	test("update() after stop() is a no-op", () => {
		const { ctx, actions } = makeCtx();
		const handle = startChatAction(ctx, "typing", 1000);
		handle.stop();
		handle.update("upload_photo");
		expect(actions).toEqual(["typing"]);
	});

	test("send failures do not throw", async () => {
		const ctx = {
			replyWithChatAction: async () => {
				throw new Error("network");
			},
		} as unknown as Context;
		const handle = startChatAction(ctx, "typing", 10);
		await sleep(25);
		expect(() => handle.stop()).not.toThrow();
	});
});

describe("withChatAction", () => {
	test("keeps the action alive during fn and stops after", async () => {
		const { ctx, actions } = makeCtx();
		const result = await withChatAction(
			ctx,
			"upload_photo",
			() => sleep(35).then(() => 42),
			10,
		);
		expect(result).toBe(42);
		expect(actions.length).toBeGreaterThanOrEqual(3);
		const countAtEnd = actions.length;
		await sleep(30);
		expect(actions.length).toBe(countAtEnd);
	});

	test("stops the action when fn throws", async () => {
		const { ctx, actions } = makeCtx();
		await expect(
			withChatAction(
				ctx,
				"typing",
				async () => {
					throw new Error("boom");
				},
				10,
			),
		).rejects.toThrow("boom");
		const countAtThrow = actions.length;
		await sleep(30);
		expect(actions.length).toBe(countAtThrow);
	});
});
