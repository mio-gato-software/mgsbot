import { expect, test } from "bun:test";
import {
	generateScheduledImage,
	planScheduledImage,
} from "../src/commitments/image.ts";
import {
	deliverScheduledMessage,
	generateScheduledDelivery,
	repairScheduledReport,
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
				delivery: "image_and_text",
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

test("image-only task paraphrases repair marker-only output before rendering and preserve delivery scope", async () => {
	for (const instruction of [
		"Entrega únicamente una imagen de la clasificación, sin texto adicional.",
		"Que solo llegue la infografía con los resultados de ayer y los juegos de hoy.",
		"Genera la tabla como foto; nada de mensajes acompañándola.",
	]) {
		let calls = 0;
		const report = "Azul 3–2 Verde. Hoy: Verde–Rojo, Estadio Ejemplo.";
		const before = { ...task, instruction };
		const result = await generateScheduledDelivery(before, {
			...services,
			planImage: async () => ({ description: "Tabla", delivery: "image_only" }),
			generate: async (system, messages) => {
				calls++;
				expect(system).toContain("INTERNAL REPORT DATA STAGE");
				expect(messages[0]?.content).toContain(instruction);
				if (calls === 1) return "[IMAGE: Infografía con resultados y tabla]";
				expect(messages.at(-1)?.content).toContain("format validation failed");
				return report;
			},
			image: async (_visual, text) => {
				expect(text).toBe(report);
				return Buffer.from("image");
			},
		});
		expect(result).toMatchObject({ text: report, delivery: "image_only" });
		expect(calls).toBe(2);
		expect(before.instruction).toBe(instruction);
	}
});

test("repeated marker-only output fails with a specific diagnostic and never renders an empty report", async () => {
	let calls = 0;
	await expect(
		generateScheduledDelivery(task, {
			...services,
			planImage: async () => ({ description: "Tabla", delivery: "image_only" }),
			generate: async () => {
				calls++;
				return "[IMAGE_SELF: unrequested character]";
			},
			image: async () => {
				throw new Error("Must not render an empty report");
			},
		}),
	).rejects.toThrow(
		"no factual text outside image markers after format repair",
	);
	expect(calls).toBe(2);
});

test("factual correction also repairs marker-only output using retained evidence", async () => {
	let calls = 0;
	const evidence = ["Source: Azul 3–2 Verde."];
	const corrected = await repairScheduledReport(
		task,
		"Old draft",
		"Correct the result",
		evidence,
		async (system, messages, operation) => {
			calls++;
			expect(operation).toBe("scheduled-report-repair");
			expect(system).toContain("INTERNAL REPORT DATA STAGE");
			expect(JSON.parse(messages[0]?.content ?? "{}").evidence).toEqual(
				evidence,
			);
			if (calls === 1) return "[IMAGE: Render Azul 3–2 Verde]";
			expect(messages.at(-1)?.content).toContain("format validation failed");
			return "Azul 3–2 Verde.";
		},
	);
	expect(corrected).toBe("Azul 3–2 Verde.");
	expect(calls).toBe(2);
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
			if (calls === 1)
				return '{"image":{"description":"Tabla actual","delivery":"image_and_text"}}';
			expect(messages.at(-1)?.content).toContain("Format validation failed");
			return '{"image":{"description":"Tabla actual","delivery":"image_and_text","canvas":"auto"}}';
		}),
	).toEqual({
		description: "Tabla actual",
		delivery: "image_and_text",
		canvas: "auto",
	});
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
				planImage: async () => ({
					description: "Tabla actual",
					delivery: "image_and_text",
				}),
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
	for (const length of [1000, 1001, 4000, 4001, 9500]) {
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
		expect(texts.join("")).toBe(length <= 1000 ? "" : text);
		expect(texts.every((chunk) => chunk.length <= 4000)).toBe(true);
	}
});

test("a saved nonstandard canvas yields the requested pixel dimensions even with a fixed-size renderer", async () => {
	const dimensions = { width: 456, height: 720 };
	const plan = await planScheduledImage(
		{ ...task, instruction: "Una infografía de 456×720 px." },
		async () =>
			JSON.stringify({
				image: {
					description: "Infografía",
					canvas: dimensions,
					delivery: "image_only",
				},
			}),
	);
	if (!plan) throw new Error("missing visual");
	const image = await generateScheduledImage(
		plan,
		"Verificado",
		async (prompt, _reference, options) => {
			expect(options?.dimensions).toEqual(dimensions);
			expect(prompt).toContain("Stack sections vertically");
			expect(prompt).toContain("360 px display width");
			expect(prompt).toContain("omit outer frames, decorative borders");
			return new Bun.Image(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
					"base64",
				),
			)
				.resize(128, 192)
				.png()
				.buffer();
		},
		async () => null,
	);
	expect(await new Bun.Image(image).metadata()).toMatchObject(dimensions);
});

test("a failed factual report never invokes the image renderer", async () => {
	let renders = 0;
	await expect(
		generateScheduledDelivery(task, {
			...services,
			planImage: async () => ({
				description: "Report illustration",
				delivery: "image_and_text",
			}),
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

test("image-only reports retain the full draft for rendering but send no caption or text", async () => {
	for (const text of ["Short report", "long ".repeat(1500)]) {
		const prepared = await generateScheduledDelivery(task, {
			...services,
			generate: async () => text,
			planImage: async () => ({
				description: "Yesterday results, standings and today's fixtures",
				delivery: "image_only" as const,
			}),
			image: async (visual, report) => {
				expect(visual.description).toContain("fixtures");
				expect(report).toBe(text.trim());
				return Buffer.from("report image");
			},
		});
		expect(prepared.text).toBe(text.trim());
		expect(prepared.delivery).toBe("image_only");
		let photos = 0;
		await deliverScheduledMessage(
			{
				sendPhoto: async (_chat, _image, options) => {
					photos++;
					expect(options?.caption).toBeUndefined();
					return {} as never;
				},
				sendMessage: async () => {
					throw new Error("Unexpected accompanying text");
				},
			},
			-99,
			prepared,
		);
		expect(photos).toBe(1);
	}
});

test("text reports preserve emoji across chunks and retry formatting only for the rejected chunk", async () => {
	const text = `${"x".repeat(3999)}🏆${"y".repeat(5000)}`;
	const delivered: string[] = [];
	let formattingRejections = 0;
	await deliverScheduledMessage(
		{
			sendPhoto: async () => {
				throw new Error("Unexpected photo");
			},
			sendMessage: async (_chat, chunk, options) => {
				if (chunk.startsWith("🏆") && options?.parse_mode) {
					formattingRejections++;
					throw new Error("Bad Request: can't parse entities");
				}
				delivered.push(chunk);
				return {} as never;
			},
		},
		-99,
		{ text },
	);
	expect(delivered.map((chunk) => chunk.length)).toEqual([3999, 4000, 1002]);
	expect(delivered.join("")).toBe(text);
	expect(formattingRejections).toBe(1);
});

test("oversized report diagnostics include the rejected length before rendering", async () => {
	await expect(
		generateScheduledDelivery(task, {
			...services,
			planImage: async () => ({ description: "Table", delivery: "image_only" }),
			generate: async () => "x".repeat(32001),
			image: async () => {
				throw new Error("Must not render invalid input");
			},
		}),
	).rejects.toThrow("Invalid scheduled report length: 32001");
});

test("mobile and exact portrait canvases reject square and landscape source images", async () => {
	const image = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
		"base64",
	);
	for (const canvas of ["mobile", { width: 480, height: 760 }] as const) {
		for (const width of [64, 96]) {
			await expect(
				generateScheduledImage(
					{ canvas, delivery: "image_only", description: "Tabla" },
					"Azul 3–2 Verde",
					() => new Bun.Image(image).resize(width, 64).png().buffer(),
				),
			).rejects.toThrow("non-portrait");
		}
	}
});

test("a framed report is redrawn once and only a readable edge-to-edge portrait is released", async () => {
	const pixel = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
		"base64",
	);
	const portrait = await new Bun.Image(pixel).resize(100, 160).png().buffer();
	const dimensions = { width: 808, height: 1280 };
	for (const accepted of [true, false]) {
		let reviews = 0;
		const prompts: string[] = [];
		const result = generateScheduledImage(
			{
				description: "Una tabla sin marco",
				canvas: dimensions,
				delivery: "image_only",
			},
			"Azul 3–2 Verde",
			async (prompt) => {
				prompts.push(prompt);
				return portrait;
			},
			async (image, visual, report) => {
				expect(await new Bun.Image(image).metadata()).toMatchObject(dimensions);
				expect(visual.description).toBe("Una tabla sin marco");
				expect(report).toBe("Azul 3–2 Verde");
				reviews++;
				return reviews === 2 && accepted
					? null
					: "Remove the decorative frame and enlarge the team names.";
			},
		);
		if (accepted)
			expect(await new Bun.Image(await result).metadata()).toMatchObject(
				dimensions,
			);
		else await expect(result).rejects.toThrow("failed validation");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Remove the decorative frame");
		expect(prompts[1]).toContain("Azul 3–2 Verde");
	}
});
