import { afterEach, describe, expect, test } from "bun:test";
import {
	OpenAiCompatibleChatProvider,
	requireEnv,
} from "../src/providers/openai-compatible.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function makeProvider() {
	return new OpenAiCompatibleChatProvider({
		name: "testprov",
		errorLabel: "TestProv",
		endpoint: "https://example.test/v1/chat/completions",
		apiKey: "sk-test",
		model: "test-model",
		extraHeaders: { "X-Custom": "yes" },
		extraBody: { temperature: 0.5 },
	});
}

function mockFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
		Promise.resolve(
			handler(String(url), init ?? {}),
		)) as unknown as typeof fetch;
}

describe("requireEnv", () => {
	test("returns the value when set", () => {
		process.env.TEST_PROVIDER_KEY = "abc";
		expect(requireEnv("TEST_PROVIDER_KEY", "testprov")).toBe("abc");
		delete process.env.TEST_PROVIDER_KEY;
	});

	test("throws a descriptive error when missing", () => {
		delete process.env.TEST_PROVIDER_KEY;
		expect(() => requireEnv("TEST_PROVIDER_KEY", "testprov")).toThrow(
			"TEST_PROVIDER_KEY is required when CHAT_PROVIDER=testprov",
		);
	});
});

describe("OpenAiCompatibleChatProvider", () => {
	test("sends system prompt, mapped roles, auth header, and extra options", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		mockFetch((url, init) => {
			captured = { url, init };
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "hola" } }] }),
				{ status: 200 },
			);
		});

		const provider = makeProvider();
		const text = await provider.generateResponse("Sé amable.", [
			{ role: "user", content: "hola bot" },
			{ role: "assistant", content: "hola humano" },
		]);

		expect(text).toBe("hola");
		if (!captured) throw new Error("fetch was not called");
		const { url, init } = captured as { url: string; init: RequestInit };
		expect(url).toBe("https://example.test/v1/chat/completions");

		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-test");
		expect(headers["X-Custom"]).toBe("yes");

		const body = JSON.parse(String(init.body));
		expect(body.model).toBe("test-model");
		expect(body.temperature).toBe(0.5);
		expect(body.messages).toEqual([
			{ role: "system", content: "Sé amable." },
			{ role: "user", content: "hola bot" },
			{ role: "assistant", content: "hola humano" },
		]);
	});

	test("returns empty string when the response has no choices", async () => {
		mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));
		const provider = makeProvider();
		expect(await provider.generateResponse("sys", [])).toBe("");
	});

	test("non-OK responses throw with the provider label and status", async () => {
		mockFetch(
			() =>
				new Response("rate limited", {
					status: 400,
					statusText: "Bad Request",
				}),
		);
		const provider = makeProvider();
		expect(provider.generateResponse("sys", [])).rejects.toThrow(
			/TestProv API error: 400 Bad Request rate limited/,
		);
	});
});
