import { afterEach, expect, spyOn, test } from "bun:test";
import { generateBackgroundResponseWithModel } from "../src/ai/core.ts";
import {
	resolveBackgroundModel,
	resolveBackgroundProvider,
} from "../src/ai/platform.ts";
import { validateProviderConfiguration } from "../src/provider-options.ts";

const originalEnv = { ...process.env };
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	fetchSpy?.mockRestore();
	process.env = { ...originalEnv };
});
function mockFetch(
	implementation: (
		url: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>,
) {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
	);
}
function configure() {
	process.env.BACKGROUND_PROVIDER = "fal";
	process.env.BACKGROUND_MODEL = "openai/gpt-5.6-luna";
	process.env.BACKGROUND_FALLBACK_TO_CHAT = "false";
	process.env.FAL_API_KEY = "test-fal-key";
	process.env.CHAT_PROVIDER = "fal";
	process.env.FAL_MODEL = "openai/gpt-6-astra";
	process.env.PROMOTION_METRICS = "false";
}
test("fal background resolves independently and requires its own key", () => {
	const env = {
		OPENAI_API_KEY: "test",
		BACKGROUND_PROVIDER: "fal",
		FAL_MODEL: "openai/gpt-6-astra",
	};
	expect(resolveBackgroundProvider(env)).toBe("fal");
	expect(resolveBackgroundModel(env)).toBe("openai/gpt-5.6-luna");
	expect(validateProviderConfiguration(env).errors).toContain(
		"Background work require FAL_API_KEY when BACKGROUND_PROVIDER=fal.",
	);
	expect(
		validateProviderConfiguration({ ...env, FAL_API_KEY: "test" }).errors,
	).toEqual([]);
});
test("background requests use Luna through fal without changing Astra chat", async () => {
	configure();
	let request: Record<string, unknown> = {};
	mockFetch(async (url, init) => {
		expect(String(url)).toBe("https://fal.run/openrouter/router");
		request = JSON.parse(String(init?.body));
		return Response.json({
			output: '{"importance":2}',
			usage: { prompt_tokens: 30, completion_tokens: 5 },
		});
	});
	const result = await generateBackgroundResponseWithModel("Extract memory", [
		{ role: "user", content: "Test fact" },
	]);
	expect(result).toEqual({
		text: '{"importance":2}',
		model: "fal:openai/gpt-5.6-luna",
	});
	expect(request.model).toBe("openai/gpt-5.6-luna");
	expect(request.reasoning).toBe(false);
	expect(process.env.FAL_MODEL).toBe("openai/gpt-6-astra");
});
test("failed background response never falls back to Astra when disabled", async () => {
	configure();
	const models: string[] = [];
	mockFetch(async (_url, init) => {
		models.push(JSON.parse(String(init?.body)).model);
		return Response.json({ error: "injected failure" });
	});
	await expect(
		generateBackgroundResponseWithModel("", [
			{ role: "user", content: "Test" },
		]),
	).rejects.toThrow("injected failure");
	expect(models).toEqual(["openai/gpt-5.6-luna"]);
});
test("missing background key does not invoke chat when fallback is disabled", async () => {
	configure();
	delete process.env.FAL_API_KEY;
	mockFetch(async () => {
		throw new Error("Unexpected network call");
	});
	await expect(generateBackgroundResponseWithModel("", [])).rejects.toThrow(
		"chat fallback is disabled",
	);
	expect(fetchSpy).not.toHaveBeenCalled();
});
