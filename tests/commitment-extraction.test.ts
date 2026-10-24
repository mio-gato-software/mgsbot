import { afterEach, expect, spyOn, test } from "bun:test";
import * as core from "../src/ai/core.ts";
import { interpretRequest } from "../src/commitments/requests.ts";

const request = {
	chatId: -1,
	userId: 1,
	userName: "Ana",
	messageId: 1,
	text: "Todos los días a las 7 AM dinos los resultados de LIDOM en bengaleses.com",
};
const raw = {
	actions: [
		{
			type: "schedule",
			evidence: request.text,
			task: {
				instruction: "Resultados de la última jornada de LIDOM",
				kind: "research",
				searchQuery: "LIDOM resultados",
				domains: ["bengaleses.com"],
				schedule: {
					frequency: "daily",
					time: "07:00",
					startDate: "2026-10-23",
				},
			},
		},
	],
};
let generate:
	| ReturnType<typeof spyOn<typeof core, "generateBackgroundResponse">>
	| undefined;
afterEach(() => generate?.mockRestore());

test("missing internal calendar fields are repaired without asking the user to repeat the request", async () => {
	generate = spyOn(core, "generateBackgroundResponse")
		.mockResolvedValueOnce(JSON.stringify(raw))
		.mockResolvedValueOnce(
			JSON.stringify({
				...raw,
				actions: [
					{
						...raw.actions[0],
						task: {
							...raw.actions[0]?.task,
							schedule: {
								...raw.actions[0]?.task.schedule,
								weekdays: [0, 1, 2, 3, 4, 5, 6],
							},
						},
					},
				],
			}),
		);
	const result = await interpretRequest(
		request,
		"{}",
		Date.parse("2026-10-22T15:00:00Z"),
	);
	expect(result.actions).toHaveLength(1);
	expect(result.clarification).toBeUndefined();
	expect(generate).toHaveBeenCalledTimes(2);
	const messages = generate.mock.calls[1]?.[1];
	expect(messages?.[0]?.content).toBe(request.text);
	expect(messages?.[1]?.role).toBe("assistant");
	expect(messages?.[2]?.content).toContain("weekdays");
});

test("schema repair is bounded and never invents a task on repeated failure", async () => {
	generate = spyOn(core, "generateBackgroundResponse").mockResolvedValue(
		"not JSON",
	);
	await expect(interpretRequest(request, "{}", Date.now())).rejects.toThrow();
	expect(generate).toHaveBeenCalledTimes(2);
});

test("deferred links use the model rather than command words and fail without prefetching", async () => {
	const { isDeferredWebRequest } = await import(
		"../src/commitments/requests.ts"
	);
	generate = spyOn(core, "generateBackgroundResponse")
		.mockResolvedValueOnce('{"defer":true}')
		.mockResolvedValueOnce('{"defer":false}')
		.mockResolvedValueOnce("invalid");
	expect(
		await isDeferredWebRequest(
			"Este sitio también para lo de siempre: https://example.com",
		),
	).toBe(true);
	expect(
		await isDeferredWebRequest(
			"Lee este artículo sobre tareas: https://example.com",
		),
	).toBe(false);
	expect(await isDeferredWebRequest("https://example.com")).toBe(true);
	expect(generate).toHaveBeenCalledTimes(3);
});
