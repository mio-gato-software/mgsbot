import { afterEach, beforeEach, expect, test } from "bun:test";
import { AlibabaChatProvider } from "../src/providers/alibaba.ts";
import { AnthropicChatProvider } from "../src/providers/anthropic.ts";
import { AzureChatProvider } from "../src/providers/azure.ts";
import { DeepSeekChatProvider } from "../src/providers/deepseek.ts";
import { FireworksChatProvider } from "../src/providers/fireworks.ts";
import { GeminiChatProvider } from "../src/providers/gemini.ts";
import { OpenAIChatProvider } from "../src/providers/openai.ts";
import { OpenRouterChatProvider } from "../src/providers/openrouter.ts";

const originalFetch = globalThis.fetch;
const settings = {
	GOOGLE_API_KEY: "test-google",
	OPENAI_API_KEY: "test-openai",
	DEEPSEEK_API_KEY: "test-deepseek",
	ANTHROPIC_API_KEY: "test-anthropic",
	DASHSCOPE_API_KEY: "test-alibaba",
	AZURE_API_KEY: "test-azure",
	AZURE_ENDPOINT: "https://azure.example.test/chat/completions",
	FIREWORKS_API_KEY: "test-fireworks",
	OPENROUTER_API_KEY: "test-router",
	OPENROUTER_HTTP_REFERER: "https://bot.example.test",
	OPENROUTER_TITLE: "Test bot",
};
const saved = new Map<string, string | undefined>();
beforeEach(() => {
	for (const [key, value] of Object.entries(settings)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});
const history = [
	{ role: "user" as const, content: "Question" },
	{ role: "assistant" as const, content: "Previous answer" },
];
const calls: Request[] = [];
function intercept(data: unknown, status = 200) {
	calls.length = 0;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		calls.push(request);
		return Response.json(data, { status });
	}) as unknown as typeof fetch;
}
const completion = {
	choices: [{ message: { content: "Answer" } }],
	usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};
const responses = {
	object: "response",
	id: "resp_test",
	output: [
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "Answer", annotations: [] }],
		},
	],
	usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
};

for (const [Provider, key, endpoint, extra] of [
	[
		AlibabaChatProvider,
		"DASHSCOPE_API_KEY",
		"https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
		{ enable_thinking: true },
	],
	[
		AzureChatProvider,
		"AZURE_API_KEY",
		settings.AZURE_ENDPOINT,
		{ max_tokens: 4096, temperature: 0.8, top_p: 0.1 },
	],
	[
		OpenRouterChatProvider,
		"OPENROUTER_API_KEY",
		"https://openrouter.ai/api/v1/chat/completions",
		{},
	],
	[
		FireworksChatProvider,
		"FIREWORKS_API_KEY",
		"https://api.fireworks.ai/inference/v1/chat/completions",
		{ temperature: 0.6, top_k: 40 },
	],
] as const) {
	test(`${Provider.name} sends its configured endpoint, credentials, model and history`, async () => {
		intercept(completion);
		const provider = new Provider("explicit-model");
		expect(await provider.generateResponse("System", history)).toBe("Answer");
		const request = calls[0];
		if (!request) throw new Error("missing request");
		expect(request.url).toBe(endpoint);
		expect(request.headers.get("authorization")).toBe(
			`Bearer ${process.env[key]}`,
		);
		expect(await request.json()).toMatchObject({
			model: "explicit-model",
			messages: [{ role: "system", content: "System" }, ...history],
			...extra,
		});
		if (Provider === OpenRouterChatProvider) {
			expect(request.headers.get("http-referer")).toBe(
				settings.OPENROUTER_HTTP_REFERER,
			);
			expect(request.headers.get("x-title")).toBe(settings.OPENROUTER_TITLE);
		}
	});
	test(`${Provider.name} refuses missing credentials and resolves default model`, () => {
		expect(new Provider().model.length).toBeGreaterThan(0);
		delete process.env[key];
		expect(() => new Provider()).toThrow(key);
	});
}

test("Fireworks vision passes image bytes and caption to the configured model", async () => {
	intercept(completion);
	expect(
		await new FireworksChatProvider("vision-model").describeImage(
			"cGl4ZWxz",
			"image/png",
			"Read chart",
		),
	).toBe("Answer");
	expect(await calls[0]?.json()).toMatchObject({
		model: "vision-model",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: expect.stringContaining("Read chart") },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,cGl4ZWxz" },
					},
				],
			},
		],
	});
});

test("Anthropic keeps system separate, authenticates, and extracts returned text", async () => {
	intercept({
		content: [{ type: "text", text: "Answer" }],
		usage: { input_tokens: 10, output_tokens: 2 },
	});
	expect(
		await new AnthropicChatProvider("claude-test").generateResponse(
			"System",
			history,
		),
	).toBe("Answer");
	expect(calls[0]?.headers.get("x-api-key")).toBe("test-anthropic");
	expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
	expect(await calls[0]?.json()).toMatchObject({
		model: "claude-test",
		system: "System",
		messages: history,
		max_tokens: 4096,
	});
	intercept({ content: [] });
	expect(
		await new AnthropicChatProvider().generateResponse("System", history),
	).toBe("");
	intercept({ error: "invalid input" }, 400);
	await expect(
		new AnthropicChatProvider().generateResponse("System", history),
	).rejects.toThrow("400");
});

test("DeepSeek sends thinking options through the actual SDK transport", async () => {
	intercept(completion);
	expect(
		await new DeepSeekChatProvider("deepseek-test").generateResponse(
			"System",
			history,
		),
	).toBe("Answer");
	expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer test-deepseek");
	expect(await calls[0]?.json()).toMatchObject({
		model: "deepseek-test",
		thinking: { type: "enabled" },
		reasoning_effort: "high",
		stream: false,
		messages: [{ role: "system", content: "System" }, ...history],
	});
	intercept({ choices: [] });
	expect(
		await new DeepSeekChatProvider().generateResponse("System", history),
	).toBe("");
});

test("OpenAI Responses includes images only on user turns and preserves history", async () => {
	intercept(responses);
	const image = { mimeType: "image/png", data: "cGl4ZWxz" };
	expect(
		await new OpenAIChatProvider("gpt-test").generateResponse(
			"System",
			history.map((msg) => ({ ...msg, mediaAttachment: image })),
		),
	).toBe("Answer");
	const body = await calls[0]?.json();
	expect(body).toMatchObject({
		model: "gpt-test",
		input: [
			{ role: "system", content: "System" },
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Question" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,cGl4ZWxz",
						detail: "auto",
					},
				],
			},
			{ role: "assistant", content: "Previous answer" },
		],
	});
});
test("OpenAI vision uses the caption and returns empty for missing model text", async () => {
	intercept(responses);
	expect(
		await new OpenAIChatProvider("gpt-test").describeImage(
			"cGl4ZWxz",
			"image/webp",
			"Read chart",
		),
	).toBe("Answer");
	expect(await calls[0]?.json()).toMatchObject({
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: expect.stringContaining("Read chart") },
					{
						type: "input_image",
						image_url: "data:image/webp;base64,cGl4ZWxz",
						detail: "auto",
					},
				],
			},
		],
	});
	intercept({ output: [] });
	expect(
		await new OpenAIChatProvider().generateResponse("System", history),
	).toBe("");
});

test("Gemini maps assistant history and inline media through the real SDK", async () => {
	intercept({
		candidates: [{ content: { parts: [{ text: "Answer" }], role: "model" } }],
		usageMetadata: {
			promptTokenCount: 10,
			candidatesTokenCount: 2,
			totalTokenCount: 12,
		},
	});
	const provider = new GeminiChatProvider("gemini-test");
	expect(
		await provider.generateResponse("System", [
			...history,
			{
				role: "user",
				content: "",
				mediaAttachment: { data: "cGl4ZWxz", mimeType: "image/png" },
			},
			{ role: "user", content: " " },
		]),
	).toBe("Answer");
	expect(await calls[0]?.json()).toMatchObject({
		systemInstruction: { parts: [{ text: "System" }] },
		contents: [
			{ role: "user", parts: [{ text: "Question" }] },
			{ role: "model", parts: [{ text: "Previous answer" }] },
			{
				role: "user",
				parts: [{ inlineData: { data: "cGl4ZWxz", mimeType: "image/png" } }],
			},
		],
	});
	await expect(
		provider.generateResponse("System", [{ role: "user", content: " " }]),
	).rejects.toThrow("No valid messages");
	intercept({ candidates: [] });
	expect(await provider.generateResponse("System", history)).toBe("");
});
for (const [Provider, key] of [
	[GeminiChatProvider, "GOOGLE_API_KEY"],
	[OpenAIChatProvider, "OPENAI_API_KEY"],
	[DeepSeekChatProvider, "DEEPSEEK_API_KEY"],
	[AnthropicChatProvider, "ANTHROPIC_API_KEY"],
] as const) {
	test(`${Provider.name} reports absent credentials`, () => {
		delete process.env[key];
		expect(() => new Provider()).toThrow(key);
	});
}
