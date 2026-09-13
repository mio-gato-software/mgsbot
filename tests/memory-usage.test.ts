import { expect, test } from "bun:test";
import { generateBackgroundResponseWithModel } from "../src/ai/core.ts";
import {
	loadMemoryUsage,
	recordMemoryUsage,
	summarizeMemoryUsage,
} from "../src/memory/usage-metrics.ts";

test("usage report distinguishes unknown usage, retries, cache hits and fallbacks", async () => {
	const ts = Date.now();
	const report = summarizeMemoryUsage([
		{ ts, operation: "extraction", model: "test", status: "error", attempt: 1 },
		{
			ts,
			operation: "extraction",
			model: "test",
			status: "ok",
			attempt: 2,
			inputTokens: 100,
			outputTokens: 20,
			cachedInputTokens: 40,
			reasoningTokens: 5,
		},
		{
			ts,
			operation: "extraction",
			model: "fallback",
			status: "ok",
			fallback: true,
		},
		{
			ts,
			operation: "embedding",
			model: "embedding",
			status: "ok",
			cacheHit: true,
		},
		{
			ts,
			operation: "embedding",
			model: "embedding",
			status: "ok",
			cacheHit: false,
			inputTokens: 10,
		},
		{ ts, operation: "prompt", status: "ok", memoryChars: 1000 },
	]);
	expect(report.groups["extraction / test"]).toMatchObject({
		calls: 2,
		errors: 1,
		retries: 1,
		knownTokenCalls: 1,
		inputTokens: 100,
		outputTokens: 20,
	});
	expect(report.groups["extraction / fallback"]).toMatchObject({
		fallbacks: 1,
		knownTokenCalls: 0,
	});
	expect(report.embeddingCache).toEqual({ lookups: 2, hits: 1 });
	expect(report.prompts.averageMemoryChars).toBe(1000);
	await recordMemoryUsage({
		operation: "test-counter-only",
		status: "ok",
		inputTokens: 123,
	});
	expect(
		(await loadMemoryUsage()).some(
			(record) =>
				record.operation === "test-counter-only" && record.inputTokens === 123,
		),
	).toBe(true);
});

test("background Responses usage is recorded with its operation", async () => {
	const originalFetch = globalThis.fetch;
	const saved = {
		BACKGROUND_PROVIDER: process.env.BACKGROUND_PROVIDER,
		BACKGROUND_MODEL: process.env.BACKGROUND_MODEL,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		PROMOTION_METRICS: process.env.PROMOTION_METRICS,
	};
	process.env.BACKGROUND_PROVIDER = "openai";
	process.env.BACKGROUND_MODEL = "gpt-test-memory";
	process.env.OPENAI_API_KEY = "test-key";
	process.env.PROMOTION_METRICS = "true";
	globalThis.fetch = Object.assign(
		async () =>
			new Response(
				JSON.stringify({
					id: "resp_test",
					object: "response",
					status: "completed",
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "ok", annotations: [] }],
						},
					],
					usage: {
						input_tokens: 80,
						output_tokens: 12,
						total_tokens: 92,
						input_tokens_details: { cached_tokens: 20 },
						output_tokens_details: { reasoning_tokens: 4 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		{ preconnect: originalFetch.preconnect },
	);
	try {
		const response = await generateBackgroundResponseWithModel(
			"system",
			[{ role: "user", content: "hello" }],
			"test-provider-usage",
		);
		expect(response.text).toBe("ok");
		const record = (await loadMemoryUsage()).find(
			(record) => record.operation === "test-provider-usage",
		);
		expect(record).toMatchObject({
			inputTokens: 80,
			outputTokens: 12,
			cachedInputTokens: 20,
			reasoningTokens: 4,
			status: "ok",
		});
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
