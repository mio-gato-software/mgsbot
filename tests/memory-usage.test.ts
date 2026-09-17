import { expect, test } from "bun:test";
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
	// A prior test may have initialized the SDK singleton with another fetch.
	// Isolate the client and install the transport mock before its first use.
	const script = `
		import './tests/preload.ts';
		import { generateBackgroundResponseWithModel } from './src/ai/core.ts';
		import { loadMemoryUsage } from './src/memory/usage-metrics.ts';
		let requests = 0;
		globalThis.fetch = Object.assign(async (url, init) => {
			if (String(url) !== 'https://api.openai.com/v1/responses')
				throw new Error('Unexpected endpoint');
			if (JSON.parse(init.body).model !== 'gpt-test-memory')
				throw new Error('Unexpected model');
			requests++;
			return Response.json({
				id: 'resp_test', object: 'response', status: 'completed',
				output: [{ type: 'message', role: 'assistant', content: [
					{ type: 'output_text', text: 'ok', annotations: [] }
				] }],
				usage: {
					input_tokens: 80, output_tokens: 12, total_tokens: 92,
					input_tokens_details: { cached_tokens: 20 },
					output_tokens_details: { reasoning_tokens: 4 }
				}
			});
		}, { preconnect: globalThis.fetch.preconnect });
		const response = await generateBackgroundResponseWithModel(
			'system', [{ role: 'user', content: 'hello' }], 'test-provider-usage'
		);
		const record = (await loadMemoryUsage()).find(
			entry => entry.operation === 'test-provider-usage'
		);
		console.log('RESULT:' + JSON.stringify({ response, record, requests }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: `${import.meta.dir}/..`,
		env: {
			...process.env,
			BACKGROUND_PROVIDER: "openai",
			BACKGROUND_MODEL: "gpt-test-memory",
			BACKGROUND_FALLBACK_TO_CHAT: "false",
			OPENAI_API_KEY: "test-no-network",
			PROMOTION_METRICS: "true",
			NODE_ENV: "production",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const { response, record, requests } = JSON.parse(
		stdout.split("RESULT:")[1] ?? "{}",
	);
	expect(requests).toBe(1);
	expect(response.text).toBe("ok");
	expect(record).toMatchObject({
		inputTokens: 80,
		outputTokens: 12,
		cachedInputTokens: 20,
		reasoningTokens: 4,
		status: "ok",
	});
});
