import { afterEach, expect, test } from "bun:test";
import { isWebSearchEnabled, searchBrave } from "../src/web-search.ts";

const originalKey = process.env.BRAVE_API_KEY;
const originalEnabled = process.env.ENABLE_WEB_SEARCH;
afterEach(() => {
	if (originalKey === undefined) delete process.env.BRAVE_API_KEY;
	else process.env.BRAVE_API_KEY = originalKey;
	if (originalEnabled === undefined) delete process.env.ENABLE_WEB_SEARCH;
	else process.env.ENABLE_WEB_SEARCH = originalEnabled;
});

test("a missing or blank optional key disables search even with the enable flag", () => {
	process.env.ENABLE_WEB_SEARCH = "true";
	delete process.env.BRAVE_API_KEY;
	expect(isWebSearchEnabled()).toBe(false);
	process.env.BRAVE_API_KEY = "  ";
	expect(isWebSearchEnabled()).toBe(false);
	process.env.BRAVE_API_KEY = "test-only";
	expect(isWebSearchEnabled()).toBe(true);
	process.env.ENABLE_WEB_SEARCH = "false";
	expect(isWebSearchEnabled()).toBe(false);
});

test("Brave web lookup bounds results, deduplicates sources and preserves provenance", async () => {
	const result = await searchBrave(
		{ query: "últimas noticias", freshness: "pw" },
		{
			apiKey: "test-key",
			fetch: (async (input, options) => {
				const url = new URL(String(input));
				expect(url.hostname).toBe("api.search.brave.com");
				expect(url.pathname).toBe("/res/v1/web/search");
				expect(url.searchParams.get("q")).toBe("últimas noticias");
				expect(url.searchParams.get("count")).toBe("3");
				expect(url.searchParams.get("freshness")).toBe("pw");
				expect(new Headers(options?.headers).get("X-Subscription-Token")).toBe(
					"test-key",
				);
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				expect(options?.redirect).toBe("error");
				return Response.json({
					web: {
						results: [
							{
								title: "bad",
								url: "javascript:alert(1)",
								description: "unsafe",
							},
							{
								title: "<b>Noticia</b>",
								url: "https://example.com/1",
								description: "<b>Report</b>",
								extra_snippets: ["Evidence"],
								page_age: "2026-09-13",
							},
							{
								title: "Duplicate",
								url: "https://example.com/1",
								description: "duplicate",
							},
							...[2, 3, 4].map((id) => ({
								title: `Source ${id}`,
								url: `https://example.com/${id}`,
								description: "x".repeat(2000),
							})),
						],
					},
				});
			}) as typeof fetch,
		},
	);
	expect(result).toHaveLength(3);
	expect(result[0]).toEqual({
		title: "Noticia",
		url: "https://example.com/1",
		text: "Report Evidence",
		published: "2026-09-13",
	});
	expect(result[1]?.text).toHaveLength(1200);
});

test("ambient headlines use the news endpoint and discovery freshness", async () => {
	const results = await searchBrave(
		{ query: "actualidad", news: true, freshness: "pd" },
		{
			apiKey: "test-key",
			fetch: (async (input) => {
				const url = new URL(String(input));
				expect(url.pathname).toBe("/res/v1/news/search");
				expect(url.searchParams.get("count")).toBe("5");
				expect(url.searchParams.get("search_lang")).toBe("es");
				return Response.json({
					results: [
						{
							title: "Headline",
							url: "https://example.com/news",
							description: "Reported event",
							age: "2 hours ago",
						},
					],
				});
			}) as typeof fetch,
		},
	);
	expect(results[0]?.published).toBe("2 hours ago");
});

test("provider errors never expose error bodies and oversized responses fail closed", async () => {
	await expect(
		searchBrave(
			{ query: "test" },
			{
				apiKey: "test-key",
				fetch: (async () =>
					new Response("secret-api-key", {
						status: 429,
					})) as unknown as typeof fetch,
			},
		),
	).rejects.toThrow("Brave search returned HTTP 429");
	await expect(
		searchBrave(
			{ query: "test" },
			{
				apiKey: "test-key",
				fetch: (async () =>
					new Response("x".repeat(512_001))) as unknown as typeof fetch,
			},
		),
	).rejects.toThrow("size limit");
});
