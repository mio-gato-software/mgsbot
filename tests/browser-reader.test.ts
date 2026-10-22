import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	type BrowserProtocol,
	browserReaderServices,
	connectBrowser,
	renderPublicPage,
} from "../src/browser-reader.ts";

let oldKey: string | undefined;
beforeEach(() => {
	oldKey = process.env.BROWSERBASE_API_KEY;
	process.env.BROWSERBASE_API_KEY = "test-secret";
});
afterEach(() => {
	if (oldKey === undefined) delete process.env.BROWSERBASE_API_KEY;
	else process.env.BROWSERBASE_API_KEY = oldKey;
});
function fixture(resourceUrl = "https://example.com/scores.js") {
	const commands: string[] = [];
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
	return { services, commands, fetched, pinned, closed: () => closed };
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
