import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	classifyEditIntent,
	classifyGroupSocialIntent,
} from "../src/ai/classifiers.ts";
import { getOpenAIClient } from "../src/ai/openai-client.ts";
import {
	resolveClassifierModel,
	resolveClassifierProvider,
} from "../src/ai/platform.ts";
import {
	formatProviderStartupSummary,
	validateProviderConfiguration,
} from "../src/provider-options.ts";

const originalEnv = { ...process.env };
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let legacySpy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
	process.env.TYPESAFE_API_KEY = "test-typesafe-key";
	process.env.CLASSIFIER_PROVIDER = "typesafe";
	process.env.AI_PLATFORM = "openai";
	process.env.OPENAI_API_KEY = "test-openai-key";
	process.env.CLASSIFIER_MODEL = "gpt-4.1-mini";
	delete process.env.TYPESAFE_MODEL;
});
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
	legacySpy?.mockRestore();
	legacySpy = undefined;
	process.env = { ...originalEnv };
});

const input = {
	mode: "name" as const,
	botName: "Brendy",
	currentSpeaker: "Ana",
	currentMessage: "Brendy, ¿qué opinas?",
	recentMessages: [],
};
function groupAnswer(
	confidence = 0.95,
	action = "respond",
	addressing = "direct",
) {
	return {
		answers: {
			addressing: { type: "choice", choice: addressing, confidence },
			action: { type: "choice", choice: action, confidence },
		},
	};
}
function mockFetch(
	implementation: (
		url: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>,
) {
	// Mock the SDK boundary: its singleton retains the fetch captured on creation.
	const responses = getOpenAIClient().responses;
	const create = (body: Parameters<typeof responses.create>[0]) => {
		const result = implementation("https://api.openai.com/v1/responses", {
			body: JSON.stringify(body),
		}).then(async (response) => response.json());
		return result;
	};
	legacySpy = spyOn(responses, "create").mockImplementation(
		create as unknown as typeof responses.create,
	);
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
	);
}
function legacyResponse(text: string) {
	return Response.json({
		output_text: text,
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		],
	});
}

test("TypeSafe auto-selection respects explicit providers and is optional without its key", () => {
	const env = { OPENAI_API_KEY: "test", TYPESAFE_API_KEY: "test" };
	expect(resolveClassifierProvider(env)).toBe("typesafe");
	expect(
		resolveClassifierModel({ ...env, CLASSIFIER_MODEL: "legacy-model" }),
	).toBe("jev-1.13.0");
	expect(resolveClassifierModel({ ...env, TYPESAFE_MODEL: "custom-jev" })).toBe(
		"custom-jev",
	);
	for (const provider of ["openai", "gemini", "fal"] as const) {
		expect(
			resolveClassifierProvider({ ...env, CLASSIFIER_PROVIDER: provider }),
		).toBe(provider);
	}
	for (const key of [undefined, "", "  "]) {
		const absent = {
			...env,
			TYPESAFE_API_KEY: key,
			CLASSIFIER_PROVIDER: "typesafe",
		};
		expect(resolveClassifierProvider(absent)).toBe("openai");
		expect(validateProviderConfiguration(absent).errors).toEqual([]);
	}
	expect(formatProviderStartupSummary(env).join("\n")).toContain(
		"Classifiers: typesafe (jev-1.13.0)",
	);
});

test("typed group answers bypass the legacy model and bound the supplied context", async () => {
	let calls = 0;
	mockFetch(async (url, init) => {
		calls++;
		expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer test-typesafe-key",
		);
		expect(init?.signal).toBeDefined();
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("jev-1.13.0");
		expect(body.questions.addressing.type).toBe("choice");
		expect(body.questions.action.type).toBe("choice");
		expect(body.state.currentMessage.length).toBeLessThanOrEqual(500);
		expect(body.state.recentMessages.length).toBeLessThanOrEqual(3000);
		return Response.json(groupAnswer());
	});
	expect(
		await classifyGroupSocialIntent({
			...input,
			currentMessage: "x".repeat(6000),
			recentMessages: Array.from({ length: 20 }, () => ({
				role: "user" as const,
				name: "Ana",
				content: "x".repeat(1000),
				timestamp: 0,
			})),
		}),
	).toEqual({ addressing: "direct", action: "respond", confidence: 0.95 });
	expect(calls).toBe(1);
});

test("confident silence is preserved and both confidence values are respected", async () => {
	const response = groupAnswer(0.95, "silence", "about_bot");
	response.answers.action.confidence = 0.85;
	mockFetch(async () => Response.json(response));
	expect(await classifyGroupSocialIntent(input)).toEqual({
		addressing: "about_bot",
		action: "silence",
		confidence: 0.85,
	});
	expect(legacySpy).not.toHaveBeenCalled();
});

test.each([0.03, 0.97])(
	"image-edit probability %s maps to a boolean",
	async (value) => {
		mockFetch(async () =>
			Response.json({ answers: { edit: { type: "noul", noul: value } } }),
		);
		expect(await classifyEditIntent("No la edites, solo comenta")).toBe(
			value >= 0.8,
		);
	},
);

test.each([
	"absent",
	"unauthorized",
	"rate-limit",
	"timeout",
	"malformed",
	"unknown-label",
	"invalid-confidence",
	"uncertain",
	"inconsistent",
])(
	"%s TypeSafe result falls back to the existing classifier and its model",
	async (scenario) => {
		if (scenario === "absent") delete process.env.TYPESAFE_API_KEY;
		const calls: string[] = [];
		mockFetch(async (url, init) => {
			calls.push(String(url));
			if (String(url).includes("api.typesafe.ai")) {
				if (scenario === "unauthorized")
					return new Response("unauthorized", { status: 401 });
				if (scenario === "rate-limit")
					return new Response("busy", { status: 429 });
				if (scenario === "timeout")
					throw new DOMException("Timed out", "TimeoutError");
				if (scenario === "malformed") return Response.json({ answers: {} });
				if (scenario === "unknown-label")
					return Response.json(groupAnswer(0.95, "respond", "invented"));
				if (scenario === "invalid-confidence")
					return Response.json(groupAnswer(2));
				if (scenario === "inconsistent")
					return Response.json(groupAnswer(0.95, "silence"));
				return Response.json(groupAnswer(0.3));
			}
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			expect(JSON.parse(String(init?.body)).model).toBe("gpt-4.1-mini");
			return legacyResponse(
				'{"addressing":"ambient","action":"silence","confidence":0.9}',
			);
		});
		expect(await classifyGroupSocialIntent(input)).toEqual({
			addressing: "ambient",
			action: "silence",
			confidence: 0.9,
		});
		expect(calls).toHaveLength(scenario === "absent" ? 1 : 2);
	},
);

test("uncertain edit requests fall back and retain a negative decision", async () => {
	mockFetch(async (url) =>
		String(url).includes("api.typesafe.ai")
			? Response.json({ answers: { edit: { type: "noul", noul: 0.5 } } })
			: legacyResponse("no"),
	);
	expect(await classifyEditIntent("¿Puedes ver esta foto?")).toBe(false);
});

test("explicit legacy provider bypasses TypeSafe even with a key", async () => {
	process.env.CLASSIFIER_PROVIDER = "openai";
	mockFetch(async (url) => {
		expect(String(url)).toBe("https://api.openai.com/v1/responses");
		return legacyResponse("yes");
	});
	expect(await classifyEditIntent("Edita la foto")).toBe(true);
});

test("empty input never calls either provider", async () => {
	mockFetch(async () => {
		throw new Error("Unexpected request");
	});
	expect(await classifyEditIntent(" ")).toBe(false);
	expect(
		await classifyGroupSocialIntent({ ...input, currentMessage: " " }),
	).toEqual({ addressing: "ambient", action: "silence", confidence: 1 });
	expect(fetchSpy).not.toHaveBeenCalled();
});
