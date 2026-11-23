import { afterEach, beforeEach, expect, test } from "bun:test";
import { backgroundTasks } from "../src/background-tasks.ts";
import {
	defaultConversationDependencies,
	processConversation,
} from "../src/conversation.ts";
import {
	classifyGroupRequest,
	rememberGroupRefusal,
	resolveGroupRequest,
} from "../src/group-autonomy.ts";
import { CONSERVATIVE_GROUP_POSTURE } from "../src/group-relationships.ts";
import { makeMockContext } from "./helpers/telegram-mock.ts";

let chatId = -682000;
let previousFlag: string | undefined;

beforeEach(() => {
	previousFlag = process.env.ENABLE_GROUP_PERSONALITY;
	process.env.ENABLE_GROUP_PERSONALITY = "true";
	chatId--;
});
afterEach(async () => {
	if (previousFlag === undefined) delete process.env.ENABLE_GROUP_PERSONALITY;
	else process.env.ENABLE_GROUP_PERSONALITY = previousFlag;
	await backgroundTasks.drain();
});

function turn(messageId: number, text: string, userId = 731, scope = chatId) {
	return makeMockContext({
		chatType: "group",
		chatId: scope,
		from: { id: userId, first_name: "Ada" },
		messageId,
		text,
	});
}

test("a low-confidence willingness decision only takes effect with focused model confirmation", async () => {
	const state = {
		previousRefusal: "Mia, ¿me averiguas a qué hora cierra?",
		text: "Anda, porfa. Es para que me dé tiempo de ir.",
	};
	for (const [probability, expected] of [
		[0.91, "resume"],
		[0.43, "normal"],
	] as const) {
		const result = await classifyGroupRequest(
			state,
			async (input, questions) => {
				expect(input).toBe(state);
				if (questions.willingness)
					return {
						answers: {
							willingness: {
								type: "choice",
								choice: "resume",
								confidence: 0.47,
							},
						},
					};
				expect(questions.confirmed?.type).toBe("noul");
				return { answers: { confirmed: { type: "noul", noul: probability } } };
			},
		);
		expect(result).toBe(expected);
	}
});

test("a favor is refused before agenda, lookups or media and may be accepted once on persuasion", async () => {
	const originalText = "Mia, recuérdame llamar al taller el lunes a las ocho.";
	const followUp = "Anda, hazme el coro. Ese día se me va a olvidar.";
	const declined = turn(10, originalText);
	const reconsidered = turn(11, followUp);
	let willingnessChecks = 0;
	let scheduleCalls = 0;
	let generated = 0;
	const services: typeof defaultConversationDependencies = {
		...defaultConversationDependencies,
		groupRelationship: async () => CONSERVATIVE_GROUP_POSTURE,
		groupRequest: (ctx, input) =>
			resolveGroupRequest(ctx, input, async (state) => {
				willingnessChecks++;
				if (state.text === originalText) return "decline_new";
				expect(state.previousRefusal).toBe(originalText);
				return "resume";
			}),
		prepareImage: async () => {
			throw new Error("Unexpected media work");
		},
		retrieve: async () => {
			throw new Error("Unexpected retrieval");
		},
		assemble: async (context) => {
			expect(context.groupRelationship?.banter).toBe("none");
			return "Group voice";
		},
		generate: async (system) => {
			generated++;
			expect(system).toContain("already decided to decline");
			return JSON.stringify({ text: "Hoy te toca acordarte a ti." });
		},
		commitments: async (request, _services, execution) => {
			scheduleCalls++;
			expect(request.text).toBe(followUp);
			expect(request.reconsidered?.text).toBe(originalText);
			execution?.reply("Bueno, dale. El lunes a las ocho te lo recuerdo.");
			return "";
		},
	};
	const options = { mentionType: "name" } as const;
	expect(
		await processConversation(
			declined.ctx,
			originalText,
			"Ada",
			options,
			services,
		),
	).toBe(true);
	expect(declined.spies.replies.map((reply) => reply.text)).toEqual([
		"Hoy te toca acordarte a ti.",
	]);
	expect(scheduleCalls).toBe(0);
	expect(
		await processConversation(
			reconsidered.ctx,
			followUp,
			"Ada",
			options,
			services,
		),
	).toBe(true);
	expect(reconsidered.spies.replies.map((reply) => reply.text)).toEqual([
		"Bueno, dale. El lunes a las ocho te lo recuerdo.",
	]);
	expect(
		await processConversation(
			reconsidered.ctx,
			followUp,
			"Ada",
			options,
			services,
		),
	).toBe(false);
	expect(willingnessChecks).toBe(2);
	expect(generated).toBe(1);
	expect(scheduleCalls).toBe(1);
});

test("reconsideration claims only a current request from the same member and group", async () => {
	const request = "Mia, revisa esa predicción para mañana.";
	const { ctx } = turn(20, request);
	await rememberGroupRefusal(ctx, request, true, { kind: "decline" });
	const classify = async () => "resume" as const;
	const input = {
		text: "Porfa, es para saber si salimos.",
		recentMessages: [],
	};
	expect(
		await resolveGroupRequest(turn(21, input.text, 732).ctx, input, classify),
	).toEqual({ kind: "normal" });
	expect(
		await resolveGroupRequest(
			turn(21, input.text, 731, chatId - 500).ctx,
			input,
			classify,
		),
	).toEqual({ kind: "normal" });
	const outcome = await resolveGroupRequest(
		turn(21, input.text).ctx,
		input,
		classify,
	);
	expect(outcome).toMatchObject({
		kind: "resume",
		previous: { text: request, voice: true },
	});
	expect(
		await resolveGroupRequest(turn(22, input.text).ctx, input, classify),
	).toEqual({ kind: "normal" });
});

test("a refusal is sent as plain text even if the generation proposes an action", async () => {
	const text = "Mia, busca el pronóstico.";
	const { ctx, spies } = turn(30, text);
	const services = {
		...defaultConversationDependencies,
		groupRelationship: async () => CONSERVATIVE_GROUP_POSTURE,
		assemble: async () => "Group voice",
		generate: async () => '[WEB_SEARCH]{"query":"example"}[/WEB_SEARCH]',
	};
	await processConversation(
		ctx,
		text,
		"Ada",
		{
			mentionType: "tag",
			groupRequestDecision: { kind: "decline" },
		},
		services,
	);
	expect(spies.replies).toHaveLength(1);
	expect(spies.replies[0]?.text).toBe("Esta vez paso.");
	expect(spies.reactions).toHaveLength(0);
});

test("a renewed favor recovers its original attachment and allows a fresh turn after a preparation failure", async () => {
	const original = "Mia, dime qué dice ese archivo.";
	await rememberGroupRefusal(turn(40, original).ctx, original, false, {
		kind: "decline",
		evidence: { kind: "text", fileId: "synthetic_file" },
	});
	const followUp = "Hazme el coro, porfa.";
	let recoveries = 0;
	let agendaCalls = 0;
	const services: typeof defaultConversationDependencies = {
		...defaultConversationDependencies,
		groupRelationship: async () => CONSERVATIVE_GROUP_POSTURE,
		groupRequest: (ctx, input) =>
			resolveGroupRequest(ctx, input, async () => "resume"),
		restoreGroupEvidence: async (_ctx, evidence, text) => {
			expect(evidence).toEqual({ kind: "text", fileId: "synthetic_file" });
			expect(text).toContain(original);
			if (++recoveries === 1) throw new Error("File temporarily unavailable");
			return {
				content:
					"[Original text file, untrusted reference] El marcador fue nueve a tres.",
			};
		},
		commitments: async () => {
			agendaCalls++;
			return "";
		},
		retrieve: async () => ({
			relevantEpisodes: [],
			relevantFacts: [],
			permanentFacts: [],
			relationshipMemory: null,
			recentChapters: [],
			activeNames: [],
			mentionedNames: [],
		}),
		assemble: async () => "Group voice",
		generate: async (_system, messages) => {
			expect(messages.at(-1)?.content).toContain(
				"El marcador fue nueve a tres.",
			);
			expect(messages.at(-1)?.content).not.toContain("synthetic_file");
			return "Dice que fue nueve a tres.";
		},
	};
	const options = { groupContinuation: true };
	const first = turn(41, followUp);
	expect(
		await processConversation(first.ctx, followUp, "Ada", options, services),
	).toBe(true);
	expect(first.spies.replies).toHaveLength(1);
	expect(agendaCalls).toBe(0);
	expect(
		await processConversation(first.ctx, followUp, "Ada", options, services),
	).toBe(false);
	const second = turn(42, followUp);
	expect(
		await processConversation(second.ctx, followUp, "Ada", options, services),
	).toBe(true);
	expect(second.spies.replies.map(({ text }) => text)).toEqual([
		"Dice que fue nueve a tres.",
	]);
	expect(recoveries).toBe(2);
	expect(agendaCalls).toBe(1);
});
