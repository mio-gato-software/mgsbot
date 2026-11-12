import { expect, test } from "bun:test";
import {
	generateScheduledImage,
	planScheduledImage,
} from "../src/commitments/image.ts";
import {
	deliverScheduledMessage,
	generateScheduledDelivery,
	scheduledGenerationServices,
} from "../src/commitments/runner.ts";
import { taskSchema } from "../src/commitments/schema.ts";

const task = taskSchema.parse({
	id: "report-example",
	chatId: -99,
	creatorId: 7,
	creatorName: "Ejemplo",
	createdAt: 1,
	updatedAt: 1,
	sourceMessageId: 1,
	evidence: "Incluye la imagen de la tabla en cada reporte.",
	instruction:
		"Resultados de ayer y tabla de posiciones. Genera y adjunta la tabla como imagen.",
	kind: "reminder",
	schedule: {
		frequency: "daily",
		time: "06:30",
		startDate: "2026-11-07",
		weekdays: [0, 1, 2, 3, 4, 5, 6],
	},
	timezone: "America/Santo_Domingo",
	expiresAt: Date.parse("2026-12-05T10:30:00Z"),
	status: "active",
	lastMessage: "Old table: Equipo Azul 4-2.",
});

const services = {
	...scheduledGenerationServices,
	retrieve: async () => ({
		relevantEpisodes: [],
		relevantFacts: [],
		permanentFacts: [],
		relationshipMemory: null,
		recentChapters: [],
		activeNames: [],
		mentionedNames: [],
	}),
	assemble: async () => "Persona",
	store: {
		preferences: async () => [],
	} as unknown as typeof scheduledGenerationServices.store,
	generate: async () =>
		"Tabla de posiciones: Equipo Azul 5-2; Equipo Verde 3-4. Racha no verificada.",
};

test("saved image requirements produce an attachment even when the report has no image marker", async () => {
	const before = structuredClone(task);
	const image = Buffer.from("generated table");
	let renders = 0;
	const result = await generateScheduledDelivery(task, {
		...services,
		planImage: async (saved) => {
			expect(saved.instruction).toBe(task.instruction);
			return {
				description:
					"Tabla de posiciones actualizada, estilo marcador deportivo",
			};
		},
		image: (visual, report) =>
			generateScheduledImage(
				visual,
				report,
				async (prompt, reference, options) => {
					renders++;
					expect(prompt).toContain("Equipo Azul 5-2");
					expect(prompt).toContain("Racha no verificada");
					expect(prompt).not.toContain("4-2");
					expect(prompt).not.toContain("Ejemplo");
					expect(reference).toBeUndefined();
					expect(options).toEqual({ allowText: true });
					return image;
				},
			),
	});
	expect(result.image).toBe(image);
	expect(renders).toBe(1);
	expect(task).toEqual(before);
});

test("text-only interpretation suppresses unsolicited image markers from the report writer", async () => {
	const result = await generateScheduledDelivery(task, {
		...services,
		planImage: async () => null,
		generate: async () => "Reporte. [IMAGE: unsolicited cat] [REACT:👍]",
		image: async () => {
			throw new Error("Unrequested image");
		},
	});
	expect(result).toEqual({ text: "Reporte.", image: undefined });
});

test("every saved instruction reaches the model, including paraphrases, negations and image topics", async () => {
	for (const instruction of [
		"Adjunta una infografía con la clasificación del día.",
		"Que el reporte traiga también el gráfico de cómo van los equipos.",
		"Entrega solo texto; no generes la tabla como foto.",
		"Recuérdame revisar las imágenes del proyecto.",
	]) {
		let calls = 0;
		await planScheduledImage(
			{ ...task, instruction },
			async (_system, messages, operation) => {
				calls++;
				expect(JSON.parse(messages[0]?.content ?? "{}")).toEqual({
					task: instruction,
				});
				expect(operation).toBe("scheduled-image-plan");
				return '{"image":null}';
			},
		);
		expect(calls).toBe(1);
	}
});

test("image plan validation repairs once and rejects malformed output without executing tools", async () => {
	let calls = 0;
	expect(
		await planScheduledImage(task, async (_system, messages) => {
			calls++;
			if (calls === 1) return "[IMAGE: unvalidated prompt]";
			expect(messages.at(-1)?.content).toContain("Format validation failed");
			return '{"image":{"description":"Tabla actual"}}';
		}),
	).toEqual({ description: "Tabla actual" });
	expect(calls).toBe(2);
	calls = 0;
	await expect(
		planScheduledImage(task, async () => {
			calls++;
			return '{"image":"", "tool":"send"}';
		}),
	).rejects.toThrow();
	expect(calls).toBe(2);
});

test("required image failure prevents a text-only success, including empty provider results", async () => {
	for (const empty of [false, true]) {
		await expect(
			generateScheduledDelivery(task, {
				...services,
				planImage: async () => ({ description: "Tabla actual" }),
				image: (visual, report) =>
					generateScheduledImage(visual, report, async () => {
						if (empty) return Buffer.alloc(0);
						throw new Error("Provider unavailable");
					}),
			}),
		).rejects.toThrow(empty ? "Empty scheduled image" : "Provider unavailable");
	}
});

test("scheduled photo captions respect Telegram limits and long reports are delivered separately", async () => {
	for (const length of [1000, 1001, 4000]) {
		const texts: string[] = [];
		const captions: (string | undefined)[] = [];
		const api = {
			sendPhoto: async (_chat, _photo, options) => {
				captions.push(options?.caption);
				return {} as never;
			},
			sendMessage: async (_chat, text) => {
				texts.push(text);
				return {} as never;
			},
		} satisfies Parameters<typeof deliverScheduledMessage>[0];
		const text = "x".repeat(length);
		await deliverScheduledMessage(api, -99, {
			text,
			image: Buffer.from("image"),
		});
		expect(captions).toEqual([length <= 1000 ? text : undefined]);
		expect(texts).toEqual(length <= 1000 ? [] : [text]);
	}
});

test("a saved nonstandard canvas yields the requested pixel dimensions even with a fixed-size renderer", async () => {
	const dimensions = { width: 456, height: 720 };
	const plan = await planScheduledImage(
		{ ...task, instruction: "Una infografía de 456×720 px." },
		async () =>
			JSON.stringify({ image: { description: "Infografía", dimensions } }),
	);
	if (!plan) throw new Error("missing visual");
	const image = await generateScheduledImage(
		plan,
		"Verificado",
		async (_prompt, _reference, options) => {
			expect(options?.dimensions).toEqual(dimensions);
			return Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
				"base64",
			);
		},
	);
	expect(await new Bun.Image(image).metadata()).toMatchObject(dimensions);
});

test("a failed factual report never invokes the image renderer", async () => {
	let renders = 0;
	await expect(
		generateScheduledDelivery(task, {
			...services,
			planImage: async () => ({ description: "Report illustration" }),
			generate: async () => {
				throw new Error("Report provider timed out");
			},
			image: async () => {
				renders++;
				return Buffer.from("wrong");
			},
		}),
	).rejects.toThrow("Report provider timed out");
	expect(renders).toBe(0);
});
