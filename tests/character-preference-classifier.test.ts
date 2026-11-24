import { afterEach, expect, spyOn, test } from "bun:test";
import {
	type CharacterPreferenceTurnInput,
	classifyCharacterPreferenceIntent,
	interpretCharacterPreferences,
} from "../src/ai/character-preference-classifier.ts";
import * as core from "../src/ai/core.ts";
import * as typed from "../src/ai/typed-classifier.ts";

const input: CharacterPreferenceTurnInput = {
	text: "¿Tú con cuál equipo te quedas de verdad?",
	profile: {
		name: "Dalia",
		personality: "Tiene buen humor y aprecia el juego colectivo.",
	},
	recent: [],
	preferences: [],
};

afterEach(() => {
	const { evaluate, generate } = mocks;
	evaluate?.mockRestore();
	generate?.mockRestore();
	delete mocks.evaluate;
	delete mocks.generate;
});

const mocks: {
	evaluate?: ReturnType<typeof spyOn<typeof typed, "evaluateTypedQuestions">>;
	generate?: ReturnType<
		typeof spyOn<typeof core, "generateBackgroundResponse">
	>;
} = {};

test.each([
	[0.81, true],
	[0.19, false],
	[0.5, null],
	[1.1, null],
] as const)(
	"typed intent uses bounded confidence for a score of %p",
	async (score, outcome) => {
		mocks.evaluate = spyOn(typed, "evaluateTypedQuestions").mockResolvedValue({
			answers: { preference: { type: "noul", noul: score } },
		});
		expect(await classifyCharacterPreferenceIntent(input)).toBe(outcome);
		expect(mocks.evaluate).toHaveBeenCalledWith(
			expect.objectContaining({ latestMessage: input.text, recent: [] }),
			{
				preference: {
					type: "noul",
					instructions: expect.stringContaining("first query"),
				},
			},
		);
	},
);

test.each([
	"¿Tú con cuál equipo te quedas de verdad?",
	"Si tú tuvieras que elegir a quién alentar, ¿por quién vas?",
])("interprets the first lasting choice when asked %p", async (text) => {
	const entry = {
		action: "create" as const,
		key: "baseball-team",
		label: "Baseball team",
		value: "I enjoy a good game and don't root for a particular team.",
		evidence: text,
	};
	mocks.generate = spyOn(core, "generateBackgroundResponse").mockResolvedValue(
		`\`\`\`json\n${JSON.stringify({ entries: [entry] })}\n\`\`\``,
	);
	expect(await interpretCharacterPreferences({ ...input, text })).toEqual({
		entries: [entry],
	});
	expect(mocks.generate).toHaveBeenCalledWith(
		expect.stringContaining("profile and rules are authoritative"),
		expect.any(Array),
		"character-preference",
		{ allowChatFallback: false },
	);
});

test("an argument may be quoted from the same speaker's preceding turn", async () => {
	const preference = {
		key: "baseball-team",
		label: "Baseball team",
		value: "I root for the Clouds.",
		updatedAt: 123,
	};
	const argument = "Los Faros entrenan gratis a los chamaquitos del barrio.";
	const entry = {
		action: "revise" as const,
		key: preference.key,
		value: "I root for the Lighthouses.",
		evidence: argument,
		reason: "Making the sport accessible aligns with what I value.",
	};
	mocks.generate = spyOn(core, "generateBackgroundResponse").mockResolvedValue(
		JSON.stringify({ entries: [entry] }),
	);
	const followUp = {
		...input,
		text: "¿Eso cambia algo para ti?",
		preferences: [preference],
	};
	expect(
		await interpretCharacterPreferences({
			...followUp,
			recent: [{ role: "speaker", text: argument }],
		}),
	).toEqual({ entries: [entry] });
	for (const role of ["other", "bot"] as const) {
		expect(
			await interpretCharacterPreferences({
				...followUp,
				recent: [{ role, text: argument }],
			}),
		).toBeNull();
	}
	const [prompt, messages] = mocks.generate.mock.calls[0] ?? [];
	expect(prompt).toContain("bare request to set, remember or adopt");
	expect(JSON.parse(messages?.[0]?.content ?? "{}").preferences).toEqual([
		{ key: preference.key, label: preference.label, value: preference.value },
	]);
});

test("the interpreter rejects unknown recall keys and invented elicitation evidence", async () => {
	const create = {
		action: "create",
		key: "baseball-team",
		label: "Baseball team",
		value: "I root for the Clouds.",
		evidence: "This was supplied only by the model.",
	};
	mocks.generate = spyOn(core, "generateBackgroundResponse")
		.mockResolvedValueOnce(
			JSON.stringify({ entries: [{ action: "recall", key: create.key }] }),
		)
		.mockResolvedValueOnce(JSON.stringify({ entries: [create] }));
	expect(await interpretCharacterPreferences(input)).toBeNull();
	expect(await interpretCharacterPreferences(input)).toBeNull();
});
