import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderBehavior } from "../src/commitments/behavior-evaluation.ts";
import { reviewCreativeNovelty } from "../src/commitments/behavior-novelty.ts";
import { behaviorSchema } from "../src/commitments/schema.ts";

const behavior = behaviorSchema.parse({
	id: "example",
	createdAt: 1,
	condition: "Victoria confirmada",
	instruction: "Crear un meme original",
	output: "image",
});
const event = {
	key: "event",
	date: "2026-11-07",
	summary: "Azul ganó 5-2 a Verde",
	evidence: [{ index: 0, quote: "Azul ganó 5-2 a Verde" }],
};
const history = [
	{
		text: "A dormir",
		concept: "El ganador noquea al rival en un ring",
		scene: "Ring con rival en la lona",
	},
];
const proposal = (concept: string) =>
	JSON.stringify({
		text: "¡Ganamos!",
		concept,
		scene: concept,
		imagePrompt: concept,
	});

test("novelty classification uses the typed fast decision and falls back to a validated model result", async () => {
	let calls = 0;
	const generate = async () => {
		calls++;
		return '{"distinct":false,"reason":"Mismo chiste con otro marcador"}';
	};
	expect(
		(
			await reviewCreativeNovelty(
				history[0] ?? { text: "" },
				history,
				generate,
				async () => false,
			)
		).distinct,
	).toBe(false);
	expect(calls).toBe(0);
	expect(
		(
			await reviewCreativeNovelty(
				{ text: "Otro marcador", concept: "Boxeo y nocaut" },
				history,
				generate,
				async () => null,
			)
		).distinct,
	).toBe(false);
	expect(calls).toBe(1);
	await expect(
		reviewCreativeNovelty(
			{ text: "Candidato" },
			history,
			async () => '{"distinct":"yes"}',
			async () => null,
		),
	).rejects.toThrow();
});

test("a repeated concept is replanned before spending an image request", async () => {
	let plans = 0,
		images = 0;
	const result = await renderBehavior(
		behavior,
		event,
		"Persona",
		history,
		async (_system, messages) => {
			plans++;
			if (plans === 1) return proposal("Otro nocaut en un ring");
			expect(messages.at(-1)?.content).toContain("too similar");
			return proposal(
				"El ganador como chef sirve al rival una sopa de cinco carreras",
			);
		},
		async () => {
			images++;
			return Buffer.from("new image");
		},
		async (candidate) => ({
			distinct: candidate.concept?.startsWith("El ganador como chef") === true,
			reason: "Cambiar solo el resultado no es nuevo",
		}),
	);
	expect(plans).toBe(2);
	expect(images).toBe(1);
	expect(result.creativeConcept).toContain("chef");
});

test("three rejected concepts skip the optional image instead of reusing an old joke", async () => {
	let plans = 0,
		images = 0;
	await expect(
		renderBehavior(
			behavior,
			event,
			"Persona",
			history,
			async () => {
				plans++;
				return proposal("La misma pelea");
			},
			async () => {
				images++;
				return Buffer.from("image");
			},
			async () => ({ distinct: false, reason: "Repite el mecanismo" }),
		),
	).rejects.toThrow("distinct");
	expect(plans).toBe(3);
	expect(images).toBe(0);
});

test("exact image duplicates are blocked even when the creative proposal passes", async () => {
	const oldImage = Buffer.from("same provider image");
	await expect(
		renderBehavior(
			behavior,
			event,
			"Persona",
			[
				{
					...history[0],
					text: "Anterior",
					imageDigest: createHash("sha256").update(oldImage).digest("hex"),
				},
			],
			async () => proposal("Nueva situación"),
			async () => oldImage,
			async () => ({ distinct: true, reason: "Concepto nuevo" }),
		),
	).rejects.toThrow("already used image");
});
