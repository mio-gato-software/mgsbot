import { expect, test } from "bun:test";
import { generateResponse } from "../src/ai/core.ts";
import {
	currentOperationSignal,
	withDeadline,
} from "../src/operation-deadline.ts";
import { withRetry } from "../src/utils.ts";

test("the chat operation releases an uncooperative provider and cancels its signal", async () => {
	let cancelled = false;
	const provider = {
		name: "injected",
		model: "test",
		generateResponse: async () => {
			currentOperationSignal()?.addEventListener("abort", () => {
				cancelled = true;
			});
			return new Promise<string>(() => {});
		},
	};
	await expect(
		generateResponse("test", [], { provider: () => provider, timeoutMs: 10 }),
	).rejects.toThrow("chat response timed out");
	expect(cancelled).toBe(true);
});

test("nested retry helpers share a budget and cancellation interrupts backoff", async () => {
	let attempts = 0;
	await expect(
		withRetry(
			() =>
				withRetry(
					async () => {
						attempts++;
						throw new Error("503 unavailable");
					},
					3,
					1,
				),
			3,
			1,
		),
	).rejects.toThrow("503");
	expect(attempts).toBe(3);
	attempts = 0;
	await expect(
		withDeadline("backoff", 10, () =>
			withRetry(
				async () => {
					attempts++;
					throw new Error("429 limited");
				},
				3,
				1000,
			),
		),
	).rejects.toThrow("backoff timed out");
	expect(attempts).toBe(1);
});

test("real SDK chat and embedding transports receive cancellation with SDK retries disabled", async () => {
	const script = `
		import { getOpenAIClient } from './src/ai/openai-client.ts';
		import { OpenAIChatProvider } from './src/providers/openai.ts';
		import { GeminiChatProvider } from './src/providers/gemini.ts';
		import { generateEmbedding } from './src/embeddings.ts';
		import { withDeadline } from './src/operation-deadline.ts';
		import { withRetry } from './src/utils.ts';
		let calls = 0, cancellations = 0;
		globalThis.fetch = async (_url, init) => {
			calls++;
			return new Promise((_, reject) => {
				const abort = () => { cancellations++; reject(init.signal.reason); };
				if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
			});
		};
		const openai = new OpenAIChatProvider();
		const gemini = new GeminiChatProvider();
		const errors = [];
		for (const operation of [
			() => openai.generateResponse('test', [{role:'user',content:'hello'}]),
			() => generateEmbedding('deadline regression ' + Date.now()),
			() => gemini.generateResponse('test', [{role:'user',content:'hello'}]),
		]) {
			try { await withDeadline('transport', 40, operation); } catch (err) { errors.push(err.name); }
		}
		const timedOutCalls = calls;
		const retryCounts = [];
		globalThis.fetch = async () => { calls++; return Response.json({ error: { message:'503 unavailable', code:503 } }, {status:503}); };
		for (const provider of [openai, gemini]) {
			calls = 0;
			try { await withRetry(() => provider.generateResponse('test', [{role:'user',content:'hello'}]), 3, 1); } catch {}
			retryCounts.push(calls);
		}
		console.log('RESULT:' + JSON.stringify({ errors, timedOutCalls, cancellations, retryCounts, timeout:getOpenAIClient().timeout, sdkRetries:getOpenAIClient().maxRetries }));
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: `${import.meta.dir}/..`,
		env: {
			...process.env,
			OPENAI_API_KEY: "test-no-network",
			GOOGLE_API_KEY: "test-no-network",
			EMBEDDING_PROVIDER: "openai",
			LOG_LEVEL: "error",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	const result = JSON.parse(stdout.split("RESULT:")[1] ?? "{}");
	expect(result).toEqual({
		errors: ["TimeoutError", "TimeoutError", "TimeoutError"],
		timedOutCalls: 3,
		cancellations: 3,
		retryCounts: [3, 3],
		timeout: 30_000,
		sdkRetries: 0,
	});
});
