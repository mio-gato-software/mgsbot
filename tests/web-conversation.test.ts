import { expect, test } from "bun:test";
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
