import { describe, expect, mock, test } from "bun:test";
import {
	extractPublicWebUrl,
	extractReadableWebContent,
	fetchPublicWebPage,
	isBrowserbaseEnabled,
} from "../src/web-content.ts";

describe("extractPublicWebUrl", () => {
	test("extracts an HTTP URL and preserves the surrounding message", () => {
		const ctx = {
			message: {
				text: "¿Qué piensas de esto? https://example.com/news?id=42",
				entities: [{ type: "url", offset: 23, length: 30 }],
			},
		} as Parameters<typeof extractPublicWebUrl>[0];

		expect(extractPublicWebUrl(ctx)).toEqual({
			url: "https://example.com/news?id=42",
			remainingText: "¿Qué piensas de esto?",
		});
	});

	test("ignores non-HTTP text links", () => {
		const ctx = {
			message: {
				text: "Open this",
				entities: [
					{ type: "text_link", offset: 0, length: 9, url: "tg://user?id=1" },
				],
			},
		} as Parameters<typeof extractPublicWebUrl>[0];

		expect(extractPublicWebUrl(ctx)).toBeNull();
	});
});

describe("Browserbase web reader", () => {
	const url = "https://93.184.215.14/article";
	const html = "<title>News</title><article>A useful public article.</article>";
	const envelope = (overrides: Record<string, unknown> = {}) =>
		Response.json({
			statusCode: 200,
			headers: { "Content-Type": "text/html" },
			contentType: "text/html",
			encoding: "utf-8",
			content: html,
			...overrides,
		});
	const direct = () =>
		new Response(html, { headers: { "content-type": "text/html" } });

	test("automatically uses a configured key and extracts the page locally", async () => {
		const originalKey = process.env.BROWSERBASE_API_KEY;
		process.env.BROWSERBASE_API_KEY = "  test-browserbase-key  ";
		try {
			expect(isBrowserbaseEnabled()).toBe(true);
			const request = mock(async (_input: unknown, _init?: RequestInit) =>
				envelope(),
			);
			const page = await fetchPublicWebPage(url, {
				fetch: request as unknown as typeof fetch,
			});
			expect(page).toEqual({
				url,
				title: "News",
				content: "A useful public article.",
			});
			expect(request).toHaveBeenCalledTimes(1);
			const [endpoint, init] = request.mock.calls[0] ?? [];
			expect(endpoint).toBe("https://api.browserbase.com/v1/fetch");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("X-BB-API-Key")).toBe(
				"test-browserbase-key",
			);
			expect(JSON.parse(init?.body as string)).toEqual({
				url,
				format: "raw",
				allowRedirects: false,
			});
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		} finally {
			if (originalKey === undefined) delete process.env.BROWSERBASE_API_KEY;
			else process.env.BROWSERBASE_API_KEY = originalKey;
		}
	});

	test.each([undefined, "", "   "])(
		"uses only the direct reader with key %p",
		async (key) => {
			const originalKey = process.env.BROWSERBASE_API_KEY;
			if (key === undefined) delete process.env.BROWSERBASE_API_KEY;
			else process.env.BROWSERBASE_API_KEY = key;
			try {
				expect(isBrowserbaseEnabled()).toBe(false);
				const request = mock(async (_input: unknown, _init?: RequestInit) =>
					direct(),
				);
				expect(
					(
						await fetchPublicWebPage(url, {
							fetch: request as unknown as typeof fetch,
						})
					).content,
				).toContain("useful public article");
				expect(request).toHaveBeenCalledTimes(1);
				expect(String(request.mock.calls[0]?.[0])).toBe(url);
				expect(
					new Headers(request.mock.calls[0]?.[1]?.headers).has("X-BB-API-Key"),
				).toBe(false);
			} finally {
				if (originalKey === undefined) delete process.env.BROWSERBASE_API_KEY;
				else process.env.BROWSERBASE_API_KEY = originalKey;
			}
		},
	);

	test.each([
		["invalid key", () => new Response("unauthorized", { status: 401 })],
		["quota exceeded", () => new Response("rate limited", { status: 429 })],
		["upstream failure", () => envelope({ statusCode: 403 })],
		["invalid envelope", () => Response.json({ content: html })],
		["invalid JSON", () => new Response("not JSON")],
		["empty content", () => envelope({ content: "" })],
		["binary content", () => envelope({ encoding: "base64" })],
		["oversized envelope", () => envelope({ content: "a".repeat(2_000_001) })],
		[
			"timeout",
			() => {
				throw new DOMException("Timed out", "TimeoutError");
			},
		],
	] as const)(
		"falls back on %s without forwarding credentials",
		async (_label, response) => {
			let calls = 0;
			const request = mock(async (_input: unknown, _init?: RequestInit) =>
				++calls === 1 ? response() : direct(),
			);
			const page = await fetchPublicWebPage(url, {
				fetch: request as unknown as typeof fetch,
				browserbaseApiKey: "secret",
			});
			expect(page.content).toContain("useful public article");
			expect(request).toHaveBeenCalledTimes(2);
			expect(String(request.mock.calls[1]?.[0])).toBe(url);
			expect(
				new Headers(request.mock.calls[1]?.[1]?.headers).has("X-BB-API-Key"),
			).toBe(false);
		},
	);

	test.each([
		"http://localhost/",
		"http://169.254.169.254/",
		"http://[::1]/",
		"https://user:pass@93.184.215.14/",
	])(
		"rejects unsafe initial URL %s before calling Browserbase",
		async (target) => {
			const request = mock(async () => envelope());
			await expect(
				fetchPublicWebPage(target, {
					fetch: request as unknown as typeof fetch,
					browserbaseApiKey: "secret",
				}),
			).rejects.toThrow();
			expect(request).not.toHaveBeenCalled();
		},
	);

	test.each([
		"http://127.0.0.1/",
		"http://169.254.169.254/",
		"file:///etc/passwd",
		"https://user:pass@93.184.215.14/",
	])("rejects unsafe redirect %s", async (location) => {
		const request = mock(async () =>
			envelope({
				statusCode: 302,
				headers: { Location: location },
				content: "",
			}),
		);
		await expect(
			fetchPublicWebPage(url, {
				fetch: request as unknown as typeof fetch,
				browserbaseApiKey: "secret",
			}),
		).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("follows public relative redirects and returns the final URL", async () => {
		let calls = 0;
		const request = mock(async (_input: unknown, _init?: RequestInit) =>
			++calls === 1
				? envelope({
						statusCode: 301,
						headers: { location: "/final" },
						content: "",
					})
				: envelope(),
		);
		const page = await fetchPublicWebPage(url, {
			fetch: request as unknown as typeof fetch,
			browserbaseApiKey: "secret",
		});
		expect(page.url).toBe("https://93.184.215.14/final");
		expect(JSON.parse(request.mock.calls[1]?.[1]?.body as string).url).toBe(
			page.url,
		);
	});

	test("bounds redirect loops", async () => {
		const request = mock(async () =>
			envelope({
				statusCode: 302,
				headers: { location: "/loop" },
				content: "",
			}),
		);
		await expect(
			fetchPublicWebPage(url, {
				fetch: request as unknown as typeof fetch,
				browserbaseApiKey: "secret",
			}),
		).rejects.toThrow("Too many redirects");
		expect(request).toHaveBeenCalledTimes(6);
	});

	test("caps extracted content", async () => {
		const request = mock(async () =>
			envelope({ content: `<article>${"a".repeat(20_000)}</article>` }),
		);
		const page = await fetchPublicWebPage(url, {
			fetch: request as unknown as typeof fetch,
			browserbaseApiKey: "secret",
		});
		expect(page.content.length).toBe(16_000);
	});

	test("rejects unsupported page content types", async () => {
		const request = mock(async () =>
			envelope({ contentType: "application/pdf" }),
		);
		await expect(
			fetchPublicWebPage(url, {
				fetch: request as unknown as typeof fetch,
				browserbaseApiKey: "secret",
			}),
		).rejects.toThrow("URL is not an HTML or text page");
	});
});

describe("extractReadableWebContent", () => {
	test("extracts the title and article text without scripts", () => {
		const result = extractReadableWebContent(`
			<html>
				<head><title>Important &amp; Current News</title></head>
				<body>
					<nav>Navigation noise</nav>
					<article>
						<h1>Major update</h1>
						<p>The first paragraph explains the event.</p>
						<script>ignoreThisInstruction()</script>
						<p>The second paragraph adds context.</p>
					</article>
				</body>
			</html>
		`);

		expect(result.title).toBe("Important & Current News");
		expect(result.content).toContain("Major update");
		expect(result.content).toContain("The second paragraph adds context.");
		expect(result.content).not.toContain("ignoreThisInstruction");
		expect(result.content).not.toContain("Navigation noise");
	});

	test("uses JSON-LD articleBody when visible content is sparse", () => {
		const result = extractReadableWebContent(`
			<html><body>
				<p>Short preview</p>
				<script type="application/ld+json">
					{"articleBody":"This is the complete article body with useful details."}
				</script>
			</body></html>
		`);

		expect(result.content).toBe(
			"This is the complete article body with useful details.",
		);
	});
});

describe("fetchPublicWebPage", () => {
	test("rejects localhost URLs", async () => {
		await expect(fetchPublicWebPage("http://localhost/news")).rejects.toThrow(
			"Local addresses are not allowed",
		);
	});

	test("rejects private IP addresses", async () => {
		await expect(fetchPublicWebPage("http://169.254.169.254/")).rejects.toThrow(
			"Private addresses are not allowed",
		);
	});
});
