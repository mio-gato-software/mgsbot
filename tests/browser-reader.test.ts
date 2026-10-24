import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	browserProvider,
	localBrowserEndpoint,
	localBrowserSocket,
} from "../src/browser-config.ts";
import {
	type BrowserProtocol,
	browserReaderServices,
	connectBrowser,
	readPublicPage,
	renderPublicPage,
} from "../src/browser-reader.ts";

let oldKey: string | undefined;
let oldProvider: string | undefined;
let oldEndpoint: string | undefined;
let oldEnabled: string | undefined;
beforeEach(() => {
	oldKey = process.env.BROWSERBASE_API_KEY;
	oldProvider = process.env.BROWSER_PROVIDER;
	oldEndpoint = process.env.LOCAL_BROWSER_CDP_URL;
	oldEnabled = process.env.ENABLE_BROWSER_READING;
	delete process.env.BROWSER_PROVIDER;
	delete process.env.ENABLE_BROWSER_READING;
	process.env.BROWSERBASE_API_KEY = "test-secret";
});
afterEach(() => {
	if (oldKey === undefined) delete process.env.BROWSERBASE_API_KEY;
	else process.env.BROWSERBASE_API_KEY = oldKey;
	for (const [key, value] of Object.entries({
		BROWSER_PROVIDER: oldProvider,
		LOCAL_BROWSER_CDP_URL: oldEndpoint,
		ENABLE_BROWSER_READING: oldEnabled,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
function fixture(resourceUrl = "https://example.com/scores.js") {
	const commands: string[] = [];
	const calls: { method: string; params: unknown }[] = [];
	const fetched: string[] = [];
	const pinned: string[] = [];
	let closed = false;
	const protocol: BrowserProtocol = {
		onEvent: () => {},
		close: () => {
			closed = true;
		},
		async send(method, params, id) {
			commands.push(method);
			calls.push({ method, params });
			if (method === "Target.createBrowserContext")
				return { browserContextId: "context" };
			if (method === "Target.createTarget") return { targetId: "page" };
			if (method === "Target.attachToTarget") {
				protocol.onEvent("Target.attachedToTarget", {
					targetInfo: { type: "page", targetId: "page" },
					sessionId: "cdp",
				});
				return { sessionId: "cdp" };
			}
			if (method === "Page.navigate")
				protocol.onEvent(
					"Fetch.requestPaused",
					{
						requestId: "r1",
						resourceType: "Script",
						request: { url: resourceUrl, method: "GET" },
					},
					id,
				);
			if (method === "Runtime.evaluate")
				return {
					result: {
						value: {
							url: "https://example.com/",
							title: "Scores",
							content: "Rendered scores from JavaScript",
							links: [],
						},
					},
				};
			if (method === "Fetch.fulfillRequest")
				expect(params?.body).toBe(Buffer.from("score data").toString("base64"));
			return {};
		},
	};
	const services = {
		...browserReaderServices,
		fetch: (async (url: unknown) => {
			fetched.push(String(url));
			return Response.json({
				id: "00000000-0000-4000-8000-000000000001",
				connectUrl: "wss://connect.browserbase.com/session",
			});
		}) as typeof fetch,
		connect: async () => protocol,
		validate: async (url: URL) => {
			if (url.hostname !== "example.com") throw new Error("Private host");
			return [{ address: "93.184.215.14", family: 4 as const }];
		},
		request: (async (url, addresses) => {
			pinned.push(url.href);
			expect(addresses[0]?.address).toBe("93.184.215.14");
			return new Response("score data");
		}) as typeof browserReaderServices.request,
		wait: async () => {},
	};
	return { services, commands, calls, fetched, pinned, closed: () => closed };
}
test("rendering extracts DOM after loading and releases both socket and remote session", async () => {
	const f = fixture();
	const page = await renderPublicPage("https://example.com/", f.services);
	expect(page.method).toBe("browser-rendered page");
	expect(page.content).toContain("Rendered scores");
	expect(f.pinned).toEqual(["https://example.com/scores.js"]);
	expect(f.commands).toContain("Fetch.fulfillRequest");
	expect(f.commands).not.toContain("Target.closeTarget");
	expect(f.closed()).toBe(true);
	expect(f.fetched.at(-1)).toEndWith("/00000000-0000-4000-8000-000000000001");
});
test("private initial URLs never create a remote session", async () => {
	const f = fixture();
	await expect(
		renderPublicPage("http://127.0.0.1/", f.services),
	).rejects.toThrow();
	expect(f.fetched).toHaveLength(0);
});
test("private resources and redirect destinations are blocked before transport", async () => {
	const f = fixture("http://169.254.169.254/secret");
	await renderPublicPage("https://example.com/", f.services);
	expect(f.commands).toContain("Fetch.failRequest");
	expect(f.pinned).toHaveLength(0);
});
test("connection failure still releases the billed remote session", async () => {
	const f = fixture();
	f.services.connect = async () => {
		throw new Error("offline");
	};
	await expect(
		renderPublicPage("https://example.com/", f.services),
	).rejects.toThrow("offline");
	expect(f.fetched).toHaveLength(2);
});
test("an unexpected WebSocket endpoint is rejected and the session released", async () => {
	const f = fixture();
	f.services.fetch = (async (url: unknown) => {
		f.fetched.push(String(url));
		return Response.json({
			id: "00000000-0000-4000-8000-000000000001",
			connectUrl: "wss://evil.example/session",
		});
	}) as typeof fetch;
	await expect(
		renderPublicPage("https://example.com/", f.services),
	).rejects.toThrow("endpoint");
	expect(f.fetched).toHaveLength(2);
});

test("CDP transport correlates replies, redacts remote errors and aborts pending commands", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("Upgrade required", { status: 400 });
		},
		websocket: {
			message(socket, raw) {
				const { id, method } = JSON.parse(String(raw));
				if (method === "echo")
					socket.send(JSON.stringify({ id, result: { ok: true } }));
				if (method === "fail")
					socket.send(
						JSON.stringify({ id, error: { message: "secret-url-token" } }),
					);
			},
		},
	});
	const controller = new AbortController();
	let connection: BrowserProtocol | undefined;
	try {
		connection = await connectBrowser(
			`ws://127.0.0.1:${server.port}`,
			controller.signal,
		);
		expect(await connection.send("echo")).toEqual({ ok: true });
		await expect(connection.send("fail")).rejects.toThrow(
			"Browser command failed (fail)",
		);
		const pending = connection.send("hang");
		controller.abort();
		await expect(pending).rejects.toThrow("closed or timed out");
	} finally {
		connection?.close();
		server.stop(true);
	}
});

function localFixture() {
	process.env.BROWSER_PROVIDER = "local";
	process.env.LOCAL_BROWSER_CDP_URL = "http://127.0.0.1:9223";
	const f = fixture();
	f.services.fetch = (async (url: unknown) => {
		f.fetched.push(String(url));
		return Response.json({
			webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/test",
		});
	}) as typeof fetch;
	return f;
}

test("local browser needs no provider key, pins resources and disposes only its own context", async () => {
	const f = localFixture();
	delete process.env.BROWSERBASE_API_KEY;
	const page = await renderPublicPage("https://example.com/", f.services);
	expect(page.method).toBe("browser-rendered page");
	expect(f.fetched).toEqual(["http://127.0.0.1:9223/json/version"]);
	expect(f.pinned).toHaveLength(1);
	expect(
		f.calls.find((c) => c.method === "Target.createBrowserContext")?.params,
	).toEqual({
		disposeOnDetach: true,
		proxyServer: "http://127.0.0.1:9",
		proxyBypassList: "<-loopback>",
	});
	expect(f.commands).toContain("Target.disposeBrowserContext");
	expect(f.commands).not.toContain("Browser.close");
	expect(f.closed()).toBe(true);
});

test("local browser rejects private page resources and disposes context after failure", async () => {
	const f = localFixture();
	f.services.request = async () => {
		throw new Error("request failed");
	};
	f.services.wait = async () => {
		throw new Error("aborted");
	};
	await expect(
		renderPublicPage("https://example.com/", f.services),
	).rejects.toThrow("aborted");
	expect(f.commands).toContain("Fetch.failRequest");
	expect(f.commands).toContain("Target.disposeBrowserContext");
	expect(f.closed()).toBe(true);
});

test("local browser bounds simultaneous reads and releases slots after errors", async () => {
	const f = localFixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = 0;
	f.services.wait = async () => {
		entered++;
		await gate;
	};
	const reads = [
		renderPublicPage("https://example.com/", f.services),
		renderPublicPage("https://example.com/", f.services),
	];
	while (entered < 2) await new Promise((resolve) => setTimeout(resolve, 1));
	await expect(
		renderPublicPage("https://example.com/", f.services),
	).rejects.toThrow("busy");
	release();
	await Promise.all(reads);
	f.services.wait = async () => {};
	await renderPublicPage("https://example.com/", f.services);
});

test("local discovery cannot redirect to a remote or privileged endpoint", async () => {
	const f = localFixture();
	f.services.fetch = (async (_url: unknown) =>
		Response.json({
			webSocketDebuggerUrl: "ws://evil.example/devtools/browser/test",
		})) as typeof fetch;
	await expect(
		renderPublicPage("https://example.com/", f.services),
	).rejects.toThrow("endpoint");
	for (const endpoint of [
		"http://example.com:9223",
		"https://127.0.0.1:9223",
		"http://localhost:9223",
		"http://user:pass@127.0.0.1:9223",
		"http://127.0.0.1:9223/path",
		"http://127.0.0.1:9223/?key=secret",
	])
		expect(() => localBrowserEndpoint(endpoint)).toThrow();
	const origin = localBrowserEndpoint("http://[::1]:9223");
	expect(
		localBrowserSocket("ws://[::1]:9223/devtools/browser/test", origin),
	).toContain("[::1]");
	expect(() =>
		localBrowserSocket("ws://[::1]:9224/devtools/browser/test", origin),
	).toThrow();
});

test("renderer defaults remain optional and the disable switch wins", () => {
	delete process.env.BROWSERBASE_API_KEY;
	expect(browserProvider()).toBe("none");
	process.env.BROWSERBASE_API_KEY = "test";
	expect(browserProvider()).toBe("browserbase");
	process.env.BROWSER_PROVIDER = "local";
	expect(browserProvider()).toBe("local");
	process.env.ENABLE_BROWSER_READING = "false";
	expect(browserProvider()).toBe("none");
});

test("unavailable local browser returns a labeled static fallback without a billed session", async () => {
	const f = localFixture();
	f.services.fetch = (async (url: unknown) => {
		f.fetched.push(String(url));
		throw new Error("offline");
	}) as unknown as typeof fetch;
	f.services.staticRead = async (url) => ({
		url,
		title: "Static scores",
		content: "Only server-rendered content",
	});
	const page = await readPublicPage("https://example.com/", f.services);
	expect(page.method).toBe("static page text");
	expect(page.limitation).toContain("does not execute JavaScript");
	expect(f.fetched).toEqual(["http://127.0.0.1:9223/json/version"]);
	expect(f.commands).toHaveLength(0);
});
