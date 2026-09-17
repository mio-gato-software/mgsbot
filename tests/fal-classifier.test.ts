import { afterEach, expect, spyOn, test } from "bun:test";
import { classifyGroupSocialIntent } from "../src/ai/classifiers.ts";
import { validateProviderConfiguration } from "../src/provider-options.ts";

const originalEnv = { ...process.env };
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
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

test("fal classifiers are valid and require FAL_API_KEY", () => {
	const env = {
		OPENAI_API_KEY: "test-openai-key",
		CLASSIFIER_PROVIDER: "fal",
		CLASSIFIER_MODEL: "deepseek/deepseek-v4.1-flash",
		CHAT_PROVIDER: "fal",
		FAL_MODEL: "openai/gpt-6-astra",
	};

	expect(validateProviderConfiguration(env).errors).toContain(
		"Classifiers require FAL_API_KEY when CLASSIFIER_PROVIDER=fal.",
	);
	expect(
		validateProviderConfiguration({ ...env, FAL_API_KEY: "test-fal-key" })
			.errors,
	).toEqual([]);
});

test("group classifiers send their configured model through fal", async () => {
	process.env.CLASSIFIER_PROVIDER = "fal";
	process.env.CLASSIFIER_MODEL = "deepseek/deepseek-v4.1-flash";
	process.env.FAL_API_KEY = "test-fal-key";
	process.env.CHAT_PROVIDER = "fal";
	process.env.FAL_MODEL = "openai/gpt-6-astra";
	delete process.env.GOOGLE_API_KEY;
	delete process.env.OPENAI_API_KEY;

	let request: Record<string, unknown> = {};
	mockFetch(async (url, init) => {
		expect(String(url)).toBe("https://fal.run/openrouter/router");
		request = JSON.parse(String(init?.body));
		return Response.json({
			output: '{"addressing":"direct","action":"respond","confidence":0.98}',
			usage: { prompt_tokens: 60, completion_tokens: 12 },
		});
	});

	const decision = await classifyGroupSocialIntent({
		mode: "name",
		botName: "Brendy",
		currentSpeaker: "Eliaquín",
		currentMessage: "Brendy, ¿qué opinas?",
		recentMessages: [],
	});

	expect(decision).toEqual({
		addressing: "direct",
		action: "respond",
		confidence: 0.98,
	});
	expect(request.model).toBe("deepseek/deepseek-v4.1-flash");
	expect(request.reasoning).toBe(false);
	expect(process.env.FAL_MODEL).toBe("openai/gpt-6-astra");
});
