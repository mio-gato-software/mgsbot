import { expect, test } from "bun:test";
import type { ConversationWeatherContext } from "../src/weather.ts";
import {
	type ConversationWebContext,
	generateWithWebSearch,
} from "../src/web-conversation.ts";

function web(): ConversationWebContext {
	return {
		isEnabled: () => true,
		context: async () => "",
		refreshHeadlines: async () => {},
		search: async () =>
			"Source excerpt: a report, not yet confirmed. https://example.com/news",
	};
}

test("disabled feature leaves the prompt and generation untouched", async () => {
	const service = web();
	service.isEnabled = () => false;
	service.context = async () => {
		throw new Error("must not read cache");
	};
	const answer = await generateWithWebSearch({
		systemPrompt: "Original",
		messages: [{ role: "user", content: "Hi" }],
		chatId: 1,
		web: service,
		announce: async () => {
			throw new Error("must not announce");
		},
		generate: async (system, messages) => {
			expect(system).toBe("Original");
			expect(messages).toEqual([{ role: "user", content: "Hi" }]);
			return "Hi!";
		},
	});
	expect(answer).toBe("Hi!");
});

test("ordinary chat and clarification need only one model call and no lookup", async () => {
	for (const reply of [
		"Qué bueno verte",
		"¿A qué noticia te refieres?",
		"[SILENCE]",
	]) {
		let calls = 0;
		const service = web();
		service.search = async () => {
			throw new Error("unexpected search");
		};
		expect(
			await generateWithWebSearch({
				systemPrompt: "Bot",
				messages: [{ role: "user", content: "¿Viste eso?" }],
				chatId: 1,
				web: service,
				announce: async () => {
					throw new Error("unexpected notice");
				},
				generate: async () => {
					calls++;
					return reply;
				},
			}),
		).toBe(reply);
		expect(calls).toBe(1);
	}
});

test("the acknowledgement arrives before search; evidence feeds the final answer transiently", async () => {
	const events: string[] = [];
	const service = web();
	service.context = async () => "Previously retrieved headline";
	service.search = async (id, request) => {
		expect(id).toBe(1);
		expect(request).toEqual({ query: "noticia identificada", freshness: "pw" });
		events.push("search");
		return "UNTRUSTED SNIPPET https://example.com/report";
	};
	const messages = [
		{ role: "user" as const, content: "¿Qué pasó con esa noticia?" },
	];
	let calls = 0;
	const reply = await generateWithWebSearch({
		systemPrompt: "Bot",
		messages,
		chatId: 1,
		web: service,
		announce: async (notice) => {
			expect(notice).toBe("Déjame buscar");
			events.push("notice");
		},
		generate: async (system, input) => {
			calls++;
			if (calls === 1) {
				expect(system).toContain("WEB AWARENESS");
				expect(input.at(-1)?.content).toContain(
					"Previously retrieved headline",
				);
				return '[WEB_SEARCH]{"query":"noticia identificada","notice":"Déjame buscar","freshness":"pw"}[/WEB_SEARCH]';
			}
			events.push("answer");
			expect(system).toContain("Do not emit WEB_SEARCH");
			expect(input.at(-1)?.content).toContain("UNTRUSTED SNIPPET");
			return "Encontré este reporte: https://example.com/report";
		},
	});
	expect(events).toEqual(["notice", "search", "answer"]);
	expect(calls).toBe(2);
	expect(reply).toContain("Encontré");
	expect(messages).toEqual([
		{ role: "user", content: "¿Qué pasó con esa noticia?" },
	]);
});

test("malformed tool output never leaks or triggers search, and repeated requests cannot loop", async () => {
	const service = web();
	let calls = 0;
	service.search = async () => {
		throw new Error("must not search");
	};
	const result = await generateWithWebSearch({
		systemPrompt: "Bot",
		messages: [{ role: "user", content: "news" }],
		chatId: 1,
		web: service,
		announce: async () => {
			throw new Error("must not announce");
		},
		generate: async (_system, messages) => {
			calls++;
			if (calls === 2)
				expect(messages.at(-1)?.content).toContain("No search was performed");
			return "[WEB_SEARCH]{invalid";
		},
	});
	expect(calls).toBe(2);
	expect(result).not.toContain("WEB_SEARCH");
	expect(result).toContain("No pude verificar");
});

test("historical context bypass skips cached news and an undelivered notice prevents lookup", async () => {
	const service = web();
	service.context = async () => {
		throw new Error("must not load history");
	};
	service.search = async () => {
		throw new Error("must not search before notice is delivered");
	};
	await expect(
		generateWithWebSearch({
			systemPrompt: "Bot",
			messages: [],
			chatId: 1,
			web: service,
			useCachedContext: false,
			generate: async () =>
				'[WEB_SEARCH]{"query":"news","notice":"Checking"}[/WEB_SEARCH]',
			announce: async () => {
				throw new Error("Telegram offline");
			},
		}),
	).rejects.toThrow("Telegram offline");
});

test("explicit page reading works without search and feeds rendered evidence to the answer", async () => {
	const service = web();
	service.isEnabled = () => false;
	const events: string[] = [];
	service.read = async (_id, url) => {
		events.push(url);
		return JSON.stringify({
			url,
			method: "browser-rendered page",
			content: "Latest scores",
		});
	};
	let calls = 0;
	const result = await generateWithWebSearch({
		systemPrompt: "Persona",
		messages: [
			{ role: "user", content: "Abre https://example.com/resultados" },
		],
		chatId: 1,
		web: service,
		announce: async () => {
			events.push("notice");
		},
		generate: async (system, messages) => {
			calls++;
			if (calls === 1) {
				expect(system).toContain("PAGE READING");
				return '[WEB_READ]{"urls":["https://example.com/resultados"],"notice":"Voy a abrirla."}[/WEB_READ]';
			}
			expect(messages.at(-1)?.content).toContain("Latest scores");
			return "Aquí están los resultados.";
		},
	});
	expect(result).toBe("Aquí están los resultados.");
	expect(events).toEqual(["notice", "https://example.com/resultados"]);
});

test("too many pages and repeated read blocks cannot escape the lookup budget", async () => {
	const service = web();
	let reads = 0;
	service.read = async () => {
		reads++;
		return "";
	};
	const result = await generateWithWebSearch({
		systemPrompt: "Persona",
		messages: [],
		chatId: 1,
		web: service,
		announce: async () => {},
		generate: async () =>
			'[WEB_READ]{"urls":["https://a.com","https://b.com","https://c.com","https://d.com"],"notice":"Voy"}[/WEB_READ]',
	});
	expect(reads).toBe(0);
	expect(result).not.toContain("WEB_READ");
});

test("weather uses the shared two-pass flow with web disabled, preserving personality and media", async () => {
	const events: string[] = [];
	const service = web();
	service.isEnabled = () => false;
	service.context = async () => {
		throw new Error("Web context is disabled");
	};
	const weather: ConversationWeatherContext = {
		isEnabled: () => true,
		instructions: () =>
			"WEATHER TOOL: use the conversation's city for follow-ups",
		lookup: async (request) => {
			expect(request).toMatchObject({
				location: "San Pedro de Macorís",
				period: "night",
			});
			events.push("lookup");
			return '{"status":"ok","location":"San Pedro de Macorís","temperature":27}';
		},
	};
	const messages = [
		{
			role: "user" as const,
			content: "¿Cómo estará esta noche en San Pedro?",
			mediaAttachment: { data: "image", mimeType: "image/jpeg" },
		},
	];
	let calls = 0;
	const result = await generateWithWebSearch({
		systemPrompt: "Friendly Dominican character",
		messages,
		chatId: 7,
		web: service,
		weather,
		announce: async (text) => {
			expect(text).toBe("Déjame mirar.");
			events.push("notice");
		},
		generate: async (system, input) => {
			calls++;
			expect(system).toContain("Friendly Dominican character");
			expect(system).not.toContain("WEB AWARENESS");
			expect(input[0]?.mediaAttachment).toEqual(messages[0]?.mediaAttachment);
			if (calls === 1)
				return '[WEATHER_LOOKUP]{"location":"San Pedro de Macorís","period":"night","notice":"Déjame mirar."}[/WEATHER_LOOKUP]';
			expect(input.at(-1)?.content).toContain('"temperature":27');
			expect(system).toContain("never substitute the ambient weather");
			events.push("answer");
			return "En San Pedro se esperan unos 27 °C esta noche.";
		},
	});
	expect(result).toContain("En San Pedro");
	expect(calls).toBe(2);
	expect(events).toEqual(["notice", "lookup", "answer"]);
	expect(messages[0]?.content).toBe("¿Cómo estará esta noche en San Pedro?");
});

test("invalid, mixed and disabled weather requests cannot run or leak repeated control blocks", async () => {
	for (const [enabled, first] of [
		[true, '[WEATHER_LOOKUP]{"hour":25,"notice":"Miro"}[/WEATHER_LOOKUP]'],
		[
			true,
			'[WEATHER_LOOKUP]{"notice":"Miro"}[/WEATHER_LOOKUP][WEB_SEARCH]{"query":"weather","notice":"Miro"}[/WEB_SEARCH]',
		],
		[true, "[WEATHER_LOOKUP]{broken"],
		[false, '[WEATHER_LOOKUP]{"notice":"Miro"}[/WEATHER_LOOKUP]'],
	] as const) {
		let calls = 0;
		const result = await generateWithWebSearch({
			systemPrompt: "Persona",
			messages: [],
			chatId: 1,
			web: web(),
			weather: {
				isEnabled: () => enabled,
				instructions: () => "Weather",
				lookup: async () => {
					throw new Error("Must not execute");
				},
			},
			announce: async () => {
				throw new Error("Must not announce");
			},
			generate: async (_system, messages) => {
				calls++;
				if (calls === 1) return first;
				expect(messages.at(-1)?.content).toContain(
					"No weather or page lookup was performed",
				);
				return '[WEATHER_LOOKUP]{"notice":"Again"}[/WEATHER_LOOKUP]';
			},
		});
		expect(calls).toBe(2);
		expect(result).not.toContain("WEATHER_LOOKUP");
		expect(result).toBe("No pude verificar eso ahora mismo.");
	}
});

test("weather outages reach final generation as missing evidence, and notice failure prevents lookup", async () => {
	let lookups = 0;
	const weather: ConversationWeatherContext = {
		isEnabled: () => true,
		instructions: () => "Weather",
		lookup: async () => {
			lookups++;
			throw new Error("Network unavailable");
		},
	};
	let calls = 0;
	const input = {
		systemPrompt: "Persona",
		messages: [],
		chatId: 1,
		web: web(),
		weather,
		announce: async () => {},
		generate: async (
			_system: string,
			messages: import("../src/providers/types.ts").ChatMessage[],
		) => {
			calls++;
			if (calls === 1)
				return '[WEATHER_LOOKUP]{"notice":"Miro"}[/WEATHER_LOOKUP]';
			expect(messages.at(-1)?.content).toContain("No weather was verified");
			return "No pude consultar el pronóstico ahora.";
		},
	};
	expect(await generateWithWebSearch(input)).toContain("No pude consultar");
	expect(lookups).toBe(1);
	calls = 0;
	await expect(
		generateWithWebSearch({
			...input,
			announce: async () => {
				throw new Error("Telegram offline");
			},
		}),
	).rejects.toThrow("Telegram offline");
	expect(lookups).toBe(1);
});

test("ordinary conversation with weather available still needs only one model call", async () => {
	let calls = 0;
	const service = web();
	service.isEnabled = () => false;
	const result = await generateWithWebSearch({
		systemPrompt: "Persona",
		messages: [{ role: "user", content: "Hola" }],
		chatId: 1,
		web: service,
		weather: {
			isEnabled: () => true,
			instructions: () => "Weather",
			lookup: async () => {
				throw new Error("Unexpected lookup");
			},
		},
		announce: async () => {
			throw new Error("Unexpected notice");
		},
		generate: async () => {
			calls++;
			return "Hola";
		},
	});
	expect(result).toBe("Hola");
	expect(calls).toBe(1);
});
