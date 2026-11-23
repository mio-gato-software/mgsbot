import type OpenAI from "openai";
import { z } from "zod";
import { log, summarizeError } from "../logger.ts";
import {
	abortable,
	currentOperationSignal,
	requestSignal,
} from "../operation-deadline.ts";
import { getOpenAIClient } from "./openai-client.ts";
import { DEFAULT_OPENAI_DECISIONS_MODEL } from "./platform.ts";
import type { ClassifierQuestions } from "./typed-classifier.ts";

const decisionsResponse = z.object({
	status: z.literal("completed").nullish(),
	answers: z.array(
		z.discriminatedUnion("type", [
			z.object({
				name: z.string(),
				type: z.literal("choice"),
				choice: z.unknown(),
				confidence: z.unknown(),
			}),
			z.object({
				name: z.string(),
				type: z.literal("predicate"),
				probability: z.unknown(),
			}),
		]),
	),
});

export async function evaluateWithDecisions(
	state: Record<string, unknown>,
	questions: ClassifierQuestions,
): Promise<unknown> {
	currentOperationSignal()?.throwIfAborted();
	if (!process.env.OPENAI_API_KEY?.trim()) return null;

	const requestQuestions = Object.entries(questions).map(
		([name, question]): OpenAI.DecisionCreateParams["questions"][number] => {
			const { instructions } = question;
			if (question.type === "noul") {
				return { name, type: "predicate", instructions };
			}
			return {
				name,
				type: "choice",
				instructions,
				choices: Object.entries(question.criteria).map(
					([value, description]) => ({ value, description }),
				),
			};
		},
	);

	const signal = requestSignal(2000);
	try {
		signal.throwIfAborted();
		const result = await abortable(
			getOpenAIClient().decisions.create(
				{
					model: DEFAULT_OPENAI_DECISIONS_MODEL,
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_json", data: state }],
						},
					],
					questions: requestQuestions,
				},
				{ signal, maxRetries: 0 },
			),
			signal,
		);
		currentOperationSignal()?.throwIfAborted();
		const parsed = decisionsResponse.safeParse(result);
		if (
			!parsed.success ||
			parsed.data.answers.length !== requestQuestions.length
		)
			return null;

		const answers = new Map<string, unknown>();
		for (const answer of parsed.data.answers) {
			if (!Object.hasOwn(questions, answer.name) || answers.has(answer.name))
				return null;
			const question = questions[answer.name];
			if (answer.type === "choice" && question?.type === "choice") {
				answers.set(answer.name, {
					type: "choice",
					choice: answer.choice,
					confidence: answer.confidence,
				});
			} else if (answer.type === "predicate" && question?.type === "noul") {
				answers.set(answer.name, { type: "noul", noul: answer.probability });
			} else {
				return null;
			}
		}
		return { answers: Object.fromEntries(answers) };
	} catch (error) {
		currentOperationSignal()?.throwIfAborted();
		log.warn(`[decisions] Classifier unavailable: ${summarizeError(error)}`);
		return null;
	}
}
