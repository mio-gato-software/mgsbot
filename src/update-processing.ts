import { run, sequentialize } from "@grammyjs/runner";
import { type Bot, Context } from "grammy";
import { ChatUpdateQueue } from "./chat-update-queue.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import {
	currentOperationSignal,
	isTimeoutError,
	UPDATE_TIMEOUT_MS,
	withDeadline,
} from "./operation-deadline.ts";
import { type RuntimeHealth, UPDATE_CONCURRENCY } from "./runtime-health.ts";
import { timeoutReply } from "./telegram-delivery.ts";

export function registerUpdateProcessing(
	bot: Bot<Context>,
	health: RuntimeHealth,
	timeoutMs = UPDATE_TIMEOUT_MS,
): void {
	bot.api.config.use(async (previous, method, payload, signal) => {
		const operation = currentOperationSignal();
		operation?.throwIfAborted();
		const controller = new AbortController();
		const cancel = () => controller.abort(operation?.reason);
		// grammY's Node types include a legacy AbortSignal; adapt it without passing
		// that shim to AbortSignal.any, which requires native signals.
		if (operation?.aborted || signal?.aborted) cancel();
		operation?.addEventListener("abort", cancel, { once: true });
		signal?.addEventListener("abort", cancel, { once: true });
		let response: Awaited<ReturnType<typeof previous>>;
		try {
			response = await previous(
				method,
				payload,
				operation ? (controller.signal as unknown as typeof signal) : signal,
			);
		} finally {
			operation?.removeEventListener("abort", cancel);
			signal?.removeEventListener("abort", cancel);
		}
		if (method === "getUpdates" && response.ok) health.polled();
		return response;
	});
	bot.use(async (_ctx, next) =>
		health.track(async () => {
			await next();
		}),
	);
	bot.use(sequentialize((ctx) => (ctx.chat ? String(ctx.chat.id) : undefined)));
	bot.use(async (ctx, next) => {
		if (health.isStopping()) return;
		const id = ctx.update.update_id;
		health.started(id);
		try {
			await withDeadline("update", timeoutMs, async () => {
				await next();
			});
		} catch (error) {
			if (!isTimeoutError(error)) throw error;
			log.warn("[turn] Provider or update deadline exceeded");
			if (ctx.chat) await ctx.reply(timeoutReply(loadConfig().language));
		} finally {
			health.completed(id);
		}
	});
}

export function startBotRunner(bot: Bot<Context>, health: RuntimeHealth) {
	const intake = new Set<Promise<void>>();
	const queue = new ChatUpdateQueue(UPDATE_CONCURRENCY, 100, async (error) =>
		bot.errorHandler(error as Parameters<typeof bot.errorHandler>[0]),
	);
	const runner = run(
		{
			init: () => bot.init(),
			api: bot.api,
			errorHandler: (error: unknown) => log.error("[polling]", error),
			handleUpdate: async (update: Parameters<typeof bot.handleUpdate>[0]) => {
				const chat = new Context(update, bot.api, bot.botInfo).chat;
				const accepted = queue.enqueue(
					chat ? String(chat.id) : `update:${update.update_id}`,
					() => bot.handleUpdate(update),
				);
				intake.add(accepted);
				try {
					await accepted;
				} finally {
					intake.delete(accepted);
				}
			},
		},
		{
			sink: { concurrency: UPDATE_CONCURRENCY },
			runner: { maxRetryTime: 120_000 },
		},
	);
	// runner 2.0.3 stops fetching before every middleware promise has settled.
	return {
		...runner,
		size: () => queue.size(),
		stop: async () => {
			await runner.stop();
			while (queue.size() || intake.size) {
				await queue.drain();
				await Promise.allSettled([...intake]);
			}
			await health.drain();
		},
	};
}
