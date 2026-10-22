import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	type ClientRequest,
	createServer,
	type IncomingMessage,
} from "node:http";
import { PassThrough } from "node:stream";
import { requestPinnedWebPage } from "../src/pinned-web-request.ts";
import { fetchPublicWebPage } from "../src/web-content.ts";

test("the real direct transport connects to the checked address without resolving the original hostname", async () => {
	let host: string | undefined;
	const server = createServer((req, res) => {
		host = req.headers.host;
		res.setHeader("Content-Type", "text/html");
		res.end("<article>Verified public page</article>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing address");
		// Only this transport test supplies a loopback address. The public reader
		// tests below verify such addresses can never pass URL validation.
		const url = new URL(
			`http://does-not-resolve.invalid:${address.port}/article`,
		);
		const response = await requestPinnedWebPage(
			url,
			[{ address: "127.0.0.1", family: 4 }],
			AbortSignal.timeout(1000),
		);
		expect(await response.text()).toContain("Verified public page");
		expect(host).toBe(url.host);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("HTTPS preserves TLS verification and Host while connecting to the checked IP", async () => {
	const transport: NonNullable<Parameters<typeof requestPinnedWebPage>[3]> = (
		url,
		options,
		callback,
	) => {
		expect(url.href).toBe("https://public.example:8443/article");
		expect(options.hostname).toBe("93.184.215.14");
		expect(options.servername).toBe("public.example");
		expect(options.headers).toHaveProperty("Host", "public.example:8443");
		expect(options.agent).toBe(false);
		expect(options.rejectUnauthorized).not.toBe(false);
		const request = new EventEmitter() as ClientRequest;
		request.end = (() => {
			const stream = new PassThrough();
			const incoming = stream as unknown as IncomingMessage;
			incoming.statusCode = 200;
			incoming.headers = { "content-type": "text/html" };
			callback(incoming);
			stream.end("<article>Page</article>");
			return request;
		}) as typeof request.end;
		return request;
	};
	const response = await requestPinnedWebPage(
		new URL("https://public.example:8443/article"),
		[{ address: "93.184.215.14", family: 4 }],
		AbortSignal.timeout(1000),
		transport,
	);
	expect(await response.text()).toContain("Page");
});

test("a changed DNS answer is never consulted by the direct connection", async () => {
	let resolutions = 0;
	const request = mock(async (_url, addresses) => {
		expect(addresses).toEqual([{ address: "93.184.215.14", family: 4 }]);
		return new Response("<article>Safe content</article>", {
			headers: { "content-type": "text/html" },
		});
	}) as unknown as typeof requestPinnedWebPage;
	await fetchPublicWebPage("https://rebinding.example/article", {
		browserbaseApiKey: "",
		resolve: async () => {
			resolutions++;
			return [
				{
					address: resolutions === 1 ? "93.184.215.14" : "127.0.0.1",
					family: 4,
				},
			];
		},
		directRequest: request,
	});
	expect(resolutions).toBe(1);
	expect(request).toHaveBeenCalledTimes(1);
});

test("every redirect is resolved and checked before a pinned connection", async () => {
	const request = mock(
		async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://private.example/" },
			}),
	) as unknown as typeof requestPinnedWebPage;
	await expect(
		fetchPublicWebPage("https://public.example/", {
			browserbaseApiKey: "",
			resolve: async (host) => [
				{
					address: host === "public.example" ? "93.184.215.14" : "127.0.0.1",
					family: 4,
				},
			],
			directRequest: request,
		}),
	).rejects.toThrow("public address");
	expect(request).toHaveBeenCalledTimes(1);
});

test("Browserbase failure uses the same pinned addresses for the direct fallback", async () => {
	const originalFetch = globalThis.fetch;
	let resolutions = 0;
	try {
		globalThis.fetch = Object.assign(
			async () => new Response("unavailable", { status: 503 }),
			{ preconnect: originalFetch.preconnect },
		);
		const request = mock(async (_url, addresses) => {
			expect(addresses).toEqual([{ address: "93.184.215.14", family: 4 }]);
			return new Response("<article>Fallback</article>", {
				headers: { "content-type": "text/html" },
			});
		}) as unknown as typeof requestPinnedWebPage;
		await fetchPublicWebPage("https://rebinding.example/", {
			browserbaseApiKey: "test-key",
			resolve: async () => {
				resolutions++;
				return [
					{
						address: resolutions === 1 ? "93.184.215.14" : "10.0.0.1",
						family: 4,
					},
				];
			},
			directRequest: request,
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(resolutions).toBe(1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("mixed public/private DNS results are rejected before transport", async () => {
	const request = mock(
		async () => new Response(""),
	) as unknown as typeof requestPinnedWebPage;
	await expect(
		fetchPublicWebPage("https://mixed.example/", {
			resolve: async () => [
				{ address: "93.184.215.14", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			],
			directRequest: request,
		}),
	).rejects.toThrow("public address");
	expect(request).not.toHaveBeenCalled();
});
