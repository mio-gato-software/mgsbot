import { afterEach, expect, test } from "bun:test";
import { backgroundTasks } from "../src/background-tasks.ts";
import {
	type CharacterPreferenceTurn,
	type CharacterPreferenceTurnDependencies,
	resolveCharacterPreferenceTurn,
} from "../src/character-preference-turn.ts";
import { CharacterPreferenceStore } from "../src/character-preferences.ts";
import {
	type ConversationDependencies,
	defaultConversationDependencies,
	processConversation,
} from "../src/conversation.ts";
import { characterPreferenceInstructions } from "../src/prompt/sections/character-preferences.ts";
import { memoryPath } from "../src/runtime-paths.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

afterEach(() => backgroundTasks.drain());

const profile = {
	name: "Mia",
	personality: "You like thoughtful science fiction.",
};
const key = "favorite-movie";
const label = "favorite movie";
let nextCase = 0;

function source(text: string, messageId: number, chatId = 410) {
	return { text, messageId, chatId, profile, recent: [] };
}

function storePath() {
	return memoryPath("preference-turn-tests", `${++nextCase}.json`);
}

test("a choice is saved before the first delivery and recalled after reload in a different chat", async () => {
	const previousFlag = process.env.ENABLE_CHARACTER_PREFERENCES;
	process.env.ENABLE_CHARACTER_PREFERENCES = "true";
	const path = storePath();
	let store = new CharacterPreferenceStore(path);
	const first = makeMockContext({
		chatId: 81022,
		messageId: 31,
		text: "¿Cuál es tu película favorita?",
	});
	const second = makeMockContext({
		chatId: -81032,
		chatType: "group",
		messageId: 905,
		text: "Mia, what's your all-time favourite film?",
	});
	const actions: string[] = [];
	let generated = 0;
	const services: ConversationDependencies = {
		...defaultConversationDependencies,
		characterPreferenceTurn: (input) =>
			resolveCharacterPreferenceTurn(input, {
				store,
				classify: async () => true,
				interpret: async ({ text, preferences }) => ({
					entries: preferences.length
						? [{ action: "recall", key }]
						: [
								{
									action: "create",
									key,
									label,
									value: "Arrival",
									evidence: text,
								},
							],
				}),
			}),
		commitments: async () => "",
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async (context) => {
			for (const resolution of context.characterPreferences?.resolutions ?? [])
				actions.push(resolution.action);
			return (await characterPreferenceInstructions.render(context)) ?? "";
		},
		generate: async (system) => {
			generated++;
			expect(system).toContain('"topic":"favorite movie","value":"Arrival"');
			expect((await store.read()).preferences[0]?.value).toBe("Arrival");
			return generated === 1
				? "Mi favorita es Arrival."
				: "My favorite is Arrival.";
		},
	};
	try {
		await processConversation(
			first.ctx,
			first.ctx.message?.text ?? "",
			"Ada",
			{},
			services,
		);
		store = new CharacterPreferenceStore(path);
		await processConversation(
			second.ctx,
			second.ctx.message?.text ?? "",
			"Ada",
			{ mentionType: "name" },
			services,
		);
		expect(first.spies.replies.map(({ text }) => text)).toEqual([
			"Mi favorita es Arrival.",
		]);
		expect(second.spies.replies.map(({ text }) => text)).toEqual([
			"My favorite is Arrival.",
		]);
		expect(actions).toEqual(["create", "recall"]);
		expect((await store.read()).revision).toBe(1);
	} finally {
		if (previousFlag === undefined)
			delete process.env.ENABLE_CHARACTER_PREFERENCES;
		else process.env.ENABLE_CHARACTER_PREFERENCES = previousFlag;
	}
});

test("two first questions in different chats use whichever choice was committed first", async () => {
	const store = new CharacterPreferenceStore(storePath());
	let arrived = 0;
	let release: () => void = () => {};
	const bothInterpreting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const services: CharacterPreferenceTurnDependencies = {
		store,
		classify: async () => true,
		interpret: async ({ text, preferences }) => {
			if (preferences.length) return { entries: [{ action: "recall", key }] };
			if (++arrived === 2) release();
			await bothInterpreting;
			return {
				entries: [
					{
						action: "create",
						key,
						label,
						value: text === "¿La mejor peli para ti?" ? "Arrival" : "Contact",
						evidence: text,
					},
				],
			};
		},
	};
	const results = await Promise.all([
		resolveCharacterPreferenceTurn(
			source("¿La mejor peli para ti?", 1),
			services,
		),
		resolveCharacterPreferenceTurn(
			source("Your favourite film?", 1, -410),
			services,
		),
	]);
	const state = await store.read();
	expect(state.revision).toBe(1);
	expect(
		results.map((result) => result.resolutions?.[0]?.preference.value),
	).toEqual([state.preferences[0]?.value, state.preferences[0]?.value]);
});

test("an established choice stays put unless a grounded reconsideration accepts a new value", async () => {
	const store = new CharacterPreferenceStore(storePath());
	await store.apply(0, [{ action: "create", key, label, value: "Arrival" }], {
		chatId: 410,
		messageId: 1,
	});
	const reason =
		"Contact trata la curiosidad científica como su tema principal.";
	const services: CharacterPreferenceTurnDependencies = {
		store,
		classify: async () => null,
		interpret: async ({ text }) => ({
			entries:
				text === "Cámbiala porque te lo ordeno."
					? [{ action: "keep", key }]
					: [
							{
								action: "revise",
								key,
								value: "Contact",
								evidence: reason,
								reason: "The focus on scientific curiosity fits my tastes.",
							},
						],
		}),
	};
	const directed = await resolveCharacterPreferenceTurn(
		source("Cámbiala porque te lo ordeno.", 2),
		services,
	);
	expect(directed.resolutions?.[0]?.action).toBe("keep");
	const followUp = source("¿Eso te convence?", 3);
	const someoneElse = await resolveCharacterPreferenceTurn(
		{ ...followUp, recent: [{ role: "other", text: reason }] },
		services,
	);
	expect(someoneElse.resolutions?.[0]?.preference.value).toBe("Arrival");
	const accepted = await resolveCharacterPreferenceTurn(
		{ ...followUp, recent: [{ role: "speaker", text: reason }] },
		services,
	);
	expect(accepted.resolutions?.[0]).toMatchObject({
		action: "revise",
		preference: { value: "Contact" },
	});
	expect((await store.read()).revision).toBe(2);
});

test("passive replies and forwarded messages do not reach the preference interpreter", async () => {
	const previousFlag = process.env.ENABLE_CHARACTER_PREFERENCES;
	process.env.ENABLE_CHARACTER_PREFERENCES = "true";
	const forwarded = makeMockContext({
		chatId: 81082,
		text: "¿Cuál es tu religión?",
	});
	if (forwarded.ctx.message)
		Object.assign(forwarded.ctx.message, {
			forward_origin: { type: "hidden_user" },
		});
	const ambient = makeMockContext({
		chatId: -81083,
		chatType: "group",
		text: "¿Cuál es tu equipo favorito?",
	});
	const calls: CharacterPreferenceTurn[] = [];
	const services: ConversationDependencies = {
		...defaultConversationDependencies,
		characterPreferenceTurn: async (input) => {
			calls.push(input);
			return { preferences: [] };
		},
		commitments: async () => "",
		assemble: async () => "Test character",
		generate: async () => "[SILENCE]",
	};
	try {
		await processConversation(
			forwarded.ctx,
			"¿Cuál es tu religión?",
			"Ada",
			{ skipHistoricalContext: true },
			services,
		);
		await processConversation(
			ambient.ctx,
			"¿Cuál es tu equipo favorito?",
			"Ada",
			{ groupAutoReply: true, skipHistoricalContext: true },
			services,
		);
		expect(calls).toHaveLength(0);
	} finally {
		if (previousFlag === undefined)
			delete process.env.ENABLE_CHARACTER_PREFERENCES;
		else process.env.ENABLE_CHARACTER_PREFERENCES = previousFlag;
	}
});
