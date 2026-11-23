import {
	afterEach,
	beforeEach,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import {
	classifyEditIntent,
	classifyGroupSocialIntent,
	classifyRepeatedSelfie,
} from "../src/ai/classifiers.ts";
import { getOpenAIClient } from "../src/ai/openai-client.ts";
import {
	resolveClassifierModel,
	resolveClassifierProvider,
} from "../src/ai/platform.ts";
import { classifyCreativeNovelty } from "../src/ai/typed-classifier.ts";
import {
	formatProviderStartupSummary,
	validateProviderConfiguration,
} from "../src/provider-options.ts";

type DecisionsCreate = ReturnType<
	typeof getOpenAIClient
>["decisions"]["create"];

const originalEnv = { ...process.env };
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let legacySpy: ReturnType<typeof spyOn> | undefined;
let decisionsSpy: Mock<DecisionsCreate> | undefined;
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
	decisionsSpy?.mockRestore();
	decisionsSpy = undefined;
	process.env = { ...originalEnv };
});

const input = {
	mode: "name" as const,
	botName: "DemoBot",
	currentSpeaker: "Ana",
	currentMessage: "DemoBot, ¿qué opinas?",
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
	decide: (...args: Parameters<DecisionsCreate>) => unknown = () => {
		throw new Error("Unexpected decision request");
	},
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
	decisionsSpy = spyOn(
		getOpenAIClient().decisions,
		"create",
	).mockImplementation((async (...args: Parameters<DecisionsCreate>) =>
		decide(...args)) as unknown as DecisionsCreate);
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

test("classifiers default to Decisions with an OpenAI key and Jev requires explicit selection", () => {
	const env = { OPENAI_API_KEY: "test", TYPESAFE_API_KEY: "test" };
	expect(resolveClassifierProvider(env)).toBe("openai-decisions");
	expect(
		resolveClassifierModel({ ...env, CLASSIFIER_MODEL: "legacy-model" }),
	).toBe("gpt-6-luna");
	expect(
		resolveClassifierProvider({
			GOOGLE_API_KEY: "test",
			TYPESAFE_API_KEY: "test",
		}),
	).toBe("gemini");
	const jev = { ...env, CLASSIFIER_PROVIDER: "typesafe" };
	expect(resolveClassifierProvider(jev)).toBe("typesafe");
	expect(resolveClassifierModel(jev)).toBe("jev-1.13.0");
	expect(resolveClassifierModel({ ...jev, TYPESAFE_MODEL: "custom-jev" })).toBe(
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
		"Classifiers: openai-decisions (gpt-6-luna)",
	);
});

test("explicit Decisions without OpenAI credentials resolves to the platform classifier", () => {
	const noOpenAI = {
		CLASSIFIER_PROVIDER: "openai-decisions",
		GOOGLE_API_KEY: "test-google-key",
		TYPESAFE_API_KEY: "test-typesafe-key",
	};
	expect(resolveClassifierProvider(noOpenAI)).toBe("gemini");
	const result = validateProviderConfiguration(noOpenAI);
	expect(result.errors).toEqual([]);
	expect(result.warnings).toContain(
		"OpenAI Decision API requires OPENAI_API_KEY. Classifiers will use gemini.",
	);
});

test("typed creative novelty handles repetition, distinct ideas and uncertain results", async () => {
	let answer = { choice: "repetitive", confidence: 0.95 };
	mockFetch(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(body.questions.novelty.type).toBe("choice");
		return Response.json({
			answers: { novelty: { type: "choice", ...answer } },
		});
	});
	expect(
		await classifyCreativeNovelty({ concept: "Same ring joke" }, [
			{ concept: "Ring joke" },
		]),
	).toBe(false);
	answer = { choice: "distinct", confidence: 0.9 };
	expect(await classifyCreativeNovelty({ concept: "Cooking joke" }, [])).toBe(
		true,
	);
	answer = { choice: "distinct", confidence: 0.5 };
	expect(
		await classifyCreativeNovelty({ concept: "Unclear joke" }, []),
	).toBeNull();
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
	expect(decisionsSpy).not.toHaveBeenCalled();
});

test.each(["typesafe", "openai"])(
	"%s receives the speaker's question about a photo and the closing remark for both follow-ups",
	async (provider) => {
		process.env.CLASSIFIER_PROVIDER = provider;
		const question = "¿Cómo quedan mis Nubes si ganan?";
		const aside = "¡Yo voy con Coral y espero que pierdan los tuyos!";
		const lastBotMessage = "Así se resuelve el desempate. ".repeat(30) + aside;
		const replies = [
			"Sigue soñando, que el título será nuestro.",
			"Y mañana te lo recordaré.",
		] as const;
		const recentMessages = [
			{
				role: "user" as const,
				name: "Ada",
				content: `[Image] ${"Standings. ".repeat(80)}`,
				userText: question,
				timestamp: 1,
			},
			{ role: "model" as const, content: lastBotMessage, timestamp: 2 },
		];
		const calls: string[] = [];
		mockFetch(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			calls.push(
				provider === "typesafe"
					? JSON.stringify(body.state)
					: body.input[0].content,
			);
			return provider === "typesafe"
				? Response.json(groupAnswer(0.9, "respond", "continuation"))
				: legacyResponse(
						'{"addressing":"continuation","action":"respond","confidence":0.9}',
					);
		});
		for (const currentMessage of replies) {
			expect(
				(
					await classifyGroupSocialIntent({
						...input,
						mode: "message",
						currentSpeaker: "Ada",
						currentMessage,
						recentMessages,
						lastBotMessage,
					})
				)?.addressing,
			).toBe("continuation");
			recentMessages.push({
				role: "user",
				name: "Ada",
				content: currentMessage,
				userText: currentMessage,
				timestamp: 3,
			});
		}
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toContain(question);
			expect(call).toContain(aside);
		}
		expect(calls[1]).toContain(replies[0]);
		expect(calls[1]).toContain(replies[1]);
	},
);

test.each(["typesafe", "openai"])(
	"%s receives image caption guidance for social addressing",
	async (provider) => {
		process.env.CLASSIFIER_PROVIDER = provider;
		const currentMessage = "DemoBot. Te traje el dibujo que te debía.";
		mockFetch(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (provider === "typesafe") {
				expect(body.state).toMatchObject({
					imageAttached: true,
					currentMessage,
				});
				expect(body.questions.addressing.instructions).toContain(
					"address the bot by name in its own sentence",
				);
				return Response.json(groupAnswer());
			}
			expect(body.input[0].content).toContain(
				"Latest message (imageAttached: true)",
			);
			expect(body.input[0].content).toContain(currentMessage);
			expect(body.input[0].content).toContain(
				"address the bot by name in its own sentence",
			);
			return legacyResponse(
				'{"addressing":"direct","action":"respond","confidence":0.95}',
			);
		});
		expect(
			await classifyGroupSocialIntent({
				...input,
				mode: "message",
				currentMessage,
				imageAttached: true,
			}),
		).toEqual({ addressing: "direct", action: "respond", confidence: 0.95 });
	},
);

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
		expect(decisionsSpy).not.toHaveBeenCalled();
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

test("the overlap classifier passes the request and clarification to Jev and falls back on uncertain evidence", async () => {
	let score = 0.99;
	let currentMessage = "¿Va en camino?";
	let fallbackCalls = 0;
	mockFetch(async (url, init) => {
		const body = JSON.parse(String(init?.body));
		if (String(url).includes("typesafe.ai")) {
			expect(body.state.currentMessage).toBe(currentMessage);
			expect(body.state.originalRequest).toBe("Enséñame cómo te ves hoy");
			expect(body.questions.repeat.type).toBe("noul");
			return Response.json({
				answers: { repeat: { type: "noul", noul: score } },
			});
		}
		fallbackCalls++;
		expect(body.input[0].content).toContain(currentMessage);
		return legacyResponse("no");
	});
	const state = {
		originalRequest: "Enséñame cómo te ves hoy",
		sameSpeaker: true,
		recentMessages: ["Ada: una selfie"],
	};
	expect(await classifyRepeatedSelfie({ ...state, currentMessage })).toBe(true);
	expect(fallbackCalls).toBe(0);
	currentMessage = "Y después otra desde más lejos";
	score = 0.5;
	expect(await classifyRepeatedSelfie({ ...state, currentMessage })).toBe(
		false,
	);
	expect(fallbackCalls).toBe(1);
});

function decisionChoice(name: string, choice: string, confidence = 0.95) {
	return {
		name,
		type: "choice",
		choice,
		confidence,
		probabilities: [{ value: choice, probability: confidence }],
	};
}

function noTextFallback(): never {
	throw new Error("Unexpected legacy or Jev classifier request");
}

test.each(["default", "openai-decisions"] as const)(
	"Decisions with CLASSIFIER_PROVIDER=%s sends named choices and photo context in one request",
	async (provider) => {
		if (provider === "default") delete process.env.CLASSIFIER_PROVIDER;
		else process.env.CLASSIFIER_PROVIDER = provider;
		const currentMessage = "DemoBot. Te traje el dibujo que te debía.";
		mockFetch(noTextFallback, () => ({
			answers: [
				decisionChoice("addressing", "direct", 0.97),
				decisionChoice("action", "respond", 0.9),
			],
		}));

		expect(
			await classifyGroupSocialIntent({
				...input,
				mode: "message",
				currentMessage,
				imageAttached: true,
			}),
		).toEqual({ addressing: "direct", action: "respond", confidence: 0.9 });
		expect(decisionsSpy).toHaveBeenCalledTimes(1);
		const [request, options] = decisionsSpy?.mock.calls[0] ?? [];
		expect(request).toMatchObject({
			model: "gpt-6-luna",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_json",
							data: { currentMessage, imageAttached: true },
						},
					],
				},
			],
			questions: [
				expect.objectContaining({
					name: "addressing",
					type: "choice",
					instructions: expect.stringContaining(
						"address the bot by name in its own sentence",
					),
					choices: expect.arrayContaining([
						expect.objectContaining({ value: "direct" }),
					]),
				}),
				expect.objectContaining({ name: "action", type: "choice" }),
			],
		});
		expect(options).toMatchObject({
			signal: expect.any(AbortSignal),
			maxRetries: 0,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(legacySpy).not.toHaveBeenCalled();
	},
);

test.each([0.02, 0.98])(
	"Decisions predicate probability %s resolves image edits and overlapping photo requests",
	async (probability) => {
		process.env.CLASSIFIER_PROVIDER = "openai-decisions";
		mockFetch(noTextFallback, (request) => ({
			answers: [
				{ name: request.questions[0]?.name, type: "predicate", probability },
			],
		}));
		const caption = "¿Me puedes cambiar el fondo a azul?";
		const selfie = {
			originalRequest: "Enséñame cómo te ves hoy",
			currentMessage: "¿Va en camino?",
			sameSpeaker: true,
			recentMessages: ["Ada: una selfie"],
		};
		expect(await classifyEditIntent(caption)).toBe(probability >= 0.8);
		expect(await classifyRepeatedSelfie(selfie)).toBe(probability >= 0.8);
		const requests = decisionsSpy?.mock.calls.map(([request]) => request);
		expect(requests?.map(({ questions }) => questions)).toMatchObject([
			[{ name: "edit", type: "predicate" }],
			[{ name: "repeat", type: "predicate" }],
		]);
		expect(requests?.[0]?.input[0]).toMatchObject({
			content: [{ type: "input_json", data: { caption, imageAttached: true } }],
		});
		expect(requests?.[1]?.input[0]).toMatchObject({
			content: [{ type: "input_json", data: selfie }],
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(legacySpy).not.toHaveBeenCalled();
	},
);

test("Decisions compares novelty from the actual image brief and keeps uncertain cases available for fallback", async () => {
	delete process.env.CLASSIFIER_PROVIDER;
	const candidate = {
		concept: "New joke",
		imagePrompt: "A rabbit drops a trophy",
	};
	const previous = [
		{ concept: "Old joke", imagePrompt: "A rabbit drops a trophy" },
	];
	let choice = decisionChoice("novelty", "repetitive");
	mockFetch(noTextFallback, () => ({ answers: [choice] }));

	expect(await classifyCreativeNovelty(candidate, previous)).toBe(false);
	const [request] = decisionsSpy?.mock.calls[0] ?? [];
	expect(request).toMatchObject({
		input: [
			{ content: [{ type: "input_json", data: { candidate, previous } }] },
		],
		questions: [{ name: "novelty", type: "choice" }],
	});
	choice = decisionChoice("novelty", "distinct", 0.5);
	expect(await classifyCreativeNovelty(candidate, previous)).toBeNull();
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(legacySpy).not.toHaveBeenCalled();
});

test.each([
	["refusal", { name: "addressing", type: "refusal" }],
	["unknown label", decisionChoice("addressing", "invented")],
	["duplicate answer", decisionChoice("action", "respond")],
	["invalid confidence", decisionChoice("addressing", "direct", 2)],
	["low confidence", decisionChoice("addressing", "direct", 0.4)],
	["unavailable", undefined],
] as const)(
	"Decisions %s falls back to the configured legacy model without contacting Jev",
	async (_scenario, addressing) => {
		delete process.env.CLASSIFIER_PROVIDER;
		mockFetch(
			async (url, init) => {
				expect(String(url)).toBe("https://api.openai.com/v1/responses");
				expect(JSON.parse(String(init?.body)).model).toBe("gpt-4.1-mini");
				return legacyResponse(
					'{"addressing":"ambient","action":"silence","confidence":0.9}',
				);
			},
			() => {
				if (!addressing) throw new Error("Decision service unavailable");
				return { answers: [addressing, decisionChoice("action", "respond")] };
			},
		);
		expect(await classifyGroupSocialIntent(input)).toEqual({
			addressing: "ambient",
			action: "silence",
			confidence: 0.9,
		});
		expect(decisionsSpy).toHaveBeenCalledTimes(1);
		expect(legacySpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	},
);

test("uncertain Decisions predicates use text fallbacks without contacting Jev", async () => {
	process.env.CLASSIFIER_PROVIDER = "openai-decisions";
	mockFetch(
		async (url) => {
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			return legacyResponse("no");
		},
		(request) => ({
			answers: [
				{
					name: request.questions[0]?.name,
					type: "predicate",
					probability: 0.5,
				},
			],
		}),
	);
	expect(await classifyEditIntent("¿Se ve bien el fondo?")).toBe(false);
	expect(
		await classifyRepeatedSelfie({
			originalRequest: "Enséñame cómo te ves hoy",
			currentMessage: "Y después otra desde más lejos",
			sameSpeaker: true,
			recentMessages: [],
		}),
	).toBe(false);
	expect(decisionsSpy).toHaveBeenCalledTimes(2);
	expect(legacySpy).toHaveBeenCalledTimes(2);
	expect(fetchSpy).not.toHaveBeenCalled();
});
