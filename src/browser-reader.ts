import { z } from "zod";
import {
	browserProvider,
	localBrowserEndpoint,
	localBrowserSocket,
} from "./browser-config.ts";
import { abortableDelay, requestSignal } from "./operation-deadline.ts";
import { requestPinnedWebPage } from "./pinned-web-request.ts";
import {
	assertPublicUrl,
	fetchPublicWebPage,
	readLimitedBody,
} from "./web-content.ts";
import { reserveWebQuota } from "./web-quota.ts";

const SESSION_URL = "https://api.browserbase.com/v1/sessions";
const sessionSchema = z.object({
	id: z.string().uuid(),
	connectUrl: z.string().url(),
});
const snapshotSchema = z.object({
	url: z.string(),
	title: z.string(),
	content: z.string(),
	links: z.array(z.object({ title: z.string(), url: z.string() })),
});
// biome-ignore lint/suspicious/noExplicitAny: CDP is a heterogeneous wire protocol; page snapshots are validated before use.
type Params = Record<string, any>;
export interface BrowserProtocol {
	send(method: string, params?: Params, sessionId?: string): Promise<Params>;
	onEvent: (method: string, params: Params, sessionId?: string) => void;
	close(): void;
}

/** Minimal CDP transport keeps the single-file Bun executable free of browser binaries. */
export function connectBrowser(
	url: string,
	signal: AbortSignal,
): Promise<BrowserProtocol> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const socket = new WebSocket(url);
		let sequence = 0;
		const pending = new Map<
			number,
			{
				resolve: (value: Params) => void;
				reject: (error: Error) => void;
				method: string;
			}
		>();
		const fail = () => {
			const error = new Error("Browser connection closed or timed out");
			reject(error);
			for (const item of pending.values()) item.reject(error);
			pending.clear();
			socket.close();
		};
		const connection: BrowserProtocol = {
			onEvent: () => {},
			send(method, params = {}, sessionId) {
				if (socket.readyState !== WebSocket.OPEN)
					return Promise.reject(new Error("Browser disconnected"));
				return new Promise((resolve, reject) => {
					const id = ++sequence;
					pending.set(id, { resolve, reject, method });
					socket.send(JSON.stringify({ id, method, params, sessionId }));
				});
			},
			close: fail,
		};
		socket.onopen = () => resolve(connection);
		socket.onerror = fail;
		socket.onclose = () => {
			signal.removeEventListener("abort", fail);
			fail();
		};
		signal.addEventListener("abort", fail, { once: true });
		socket.onmessage = (event) => {
			try {
				const message = JSON.parse(String(event.data));
				if (message.id) {
					const item = pending.get(message.id);
					pending.delete(message.id);
					if (message.error)
						item?.reject(new Error(`Browser command failed (${item?.method})`));
					else item?.resolve(message.result ?? {});
				} else
					connection.onEvent(
						message.method,
						message.params ?? {},
						message.sessionId,
					);
			} catch {
				fail();
			}
		};
	});
}

export function browserReadingEnabled(): boolean {
	return browserProvider() !== "none";
}
let activeLocalReads = 0;
export const browserReaderServices = {
	fetch: fetch as typeof fetch,
	staticRead: fetchPublicWebPage,
	connect: connectBrowser,
	validate: (url: URL) => assertPublicUrl(url),
	request: requestPinnedWebPage,
	wait: (signal: AbortSignal) => abortableDelay(3500, signal),
};

const SNAPSHOT = `(() => ({url:location.href,title:document.title.slice(0,300),content:[document.body?.innerText||'',...Array.from(document.querySelectorAll('iframe')).map(f=>{try{return f.contentDocument?.body?.innerText||''}catch{return ''}})].join('\\n\\n').slice(0,16000),links:Array.from(document.querySelectorAll('a[href]')).map(a=>({title:(a.textContent||'').trim().slice(0,100),url:a.href})).filter(a=>a.title&&a.url.length<=2000&&/^https?:/.test(a.url)).slice(0,10)}))()`;

/** Fresh read-only session; all HTTP resources are fetched through the pinned public reader. */
export async function renderPublicPage(
	rawUrl: string,
	services = browserReaderServices,
) {
	const url = new URL(rawUrl);
	await services.validate(url);
	const provider = browserProvider();
	const local = provider === "local";
	const apiKey = process.env.BROWSERBASE_API_KEY?.trim() ?? "";
	if (provider === "none" || (!local && !apiKey))
		throw new Error("Browser reading is not configured");
	if (local && activeLocalReads >= 2) throw new Error("Local browser is busy");
	if (local) activeLocalReads++;
	let contextId: string | undefined;
	let protocol: BrowserProtocol | undefined;
	let sessionId: string | undefined;
	const signal = requestSignal(45000);
	const headers = {
		"Content-Type": "application/json",
		"X-BB-API-Key": apiKey,
	};
	try {
		let socketUrl: string;
		if (local) {
			const endpoint = localBrowserEndpoint(
				process.env.LOCAL_BROWSER_CDP_URL ?? "",
			);
			const response = await services.fetch(
				new URL("/json/version", endpoint),
				{
					signal,
					redirect: "error",
				},
			);
			if (!response.ok) throw new Error("Local browser unavailable");
			const info = z
				.object({ webSocketDebuggerUrl: z.string() })
				.parse(JSON.parse(await readLimitedBody(response)));
			socketUrl = localBrowserSocket(info.webSocketDebuggerUrl, endpoint);
		} else {
			await reserveWebQuota("browserbase-session", apiKey);
			const response = await services.fetch(SESSION_URL, {
				method: "POST",
				headers,
				redirect: "error",
				signal,
				body: JSON.stringify({
					timeout: 60,
					keepAlive: false,
					browserSettings: { recordSession: false, logSession: false },
				}),
			});
			if (!response.ok) throw new Error("Browser session unavailable");
			const session = sessionSchema.parse(await response.json());
			sessionId = session.id;
			const endpoint = new URL(session.connectUrl);
			if (
				endpoint.protocol !== "wss:" ||
				!(
					endpoint.hostname === "browserbase.com" ||
					endpoint.hostname.endsWith(".browserbase.com")
				)
			)
				throw new Error("Unexpected browser endpoint");
			socketUrl = session.connectUrl;
		}
		const cdp = await services.connect(socketUrl, signal);
		protocol = cdp;
		const frames = new Set<string>();
		let requests = 0;
		let mainTargetId = "";
		const work = new Set<Promise<unknown>>();
		const configure = async (id: string) => {
			frames.add(id);
			await cdp.send(
				"Fetch.enable",
				{ patterns: [{ urlPattern: "*", requestStage: "Request" }] },
				id,
			);
			await cdp.send("Network.enable", {}, id);
			await cdp.send(
				"Network.setBlockedURLs",
				{ urls: ["ws://*", "wss://*"] },
				id,
			);
			await cdp.send("Network.setBypassServiceWorker", { bypass: true }, id);
			await cdp.send(
				"Target.setAutoAttach",
				{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				id,
			);
			await cdp.send("Runtime.runIfWaitingForDebugger", {}, id);
		};
		const handle = async (method: string, params: Params, id?: string) => {
			if (method === "Target.attachedToTarget") {
				if (params.targetInfo.targetId === mainTargetId) return;
				if (params.targetInfo.type === "iframe")
					await configure(params.sessionId);
				else
					await cdp.send("Target.closeTarget", {
						targetId: params.targetInfo.targetId,
					});
			}
			if (method !== "Fetch.requestPaused" || !id) return;
			try {
				if (
					++requests > 160 ||
					!["GET", "HEAD"].includes(params.request.method) ||
					["Image", "Media", "Font"].includes(params.resourceType)
				)
					throw new Error("Resource excluded");
				const target = new URL(params.request.url);
				const addresses = await services.validate(target);
				const response = await services.request(
					target,
					addresses,
					AbortSignal.any([signal, AbortSignal.timeout(10000)]),
				);
				const body = await readLimitedBody(response);
				await cdp.send(
					"Fetch.fulfillRequest",
					{
						requestId: params.requestId,
						responseCode: response.status,
						responseHeaders: [...response.headers]
							.filter(
								([name]) =>
									!["content-length", "transfer-encoding"].includes(name),
							)
							.map(([name, value]) => ({ name, value })),
						body: Buffer.from(body).toString("base64"),
					},
					id,
				);
			} catch {
				await cdp
					.send(
						"Fetch.failRequest",
						{ requestId: params.requestId, errorReason: "BlockedByClient" },
						id,
					)
					.catch(() => {});
			}
		};
		cdp.onEvent = (method, params, id) => {
			const task = handle(method, params, id).catch(() => {});
			work.add(task);
			void task.finally(() => work.delete(task));
		};
		const context = await cdp.send("Target.createBrowserContext", {
			disposeOnDetach: true,
			// Fail closed for traffic outside intercepted HTTP requests (workers, sockets, etc.).
			...(local
				? { proxyServer: "http://127.0.0.1:9", proxyBypassList: "<-loopback>" }
				: {}),
		});
		contextId = context.browserContextId;
		await cdp.send("Browser.setDownloadBehavior", {
			behavior: "deny",
			browserContextId: context.browserContextId,
		});
		const target = await cdp.send("Target.createTarget", {
			url: "about:blank",
			browserContextId: context.browserContextId,
		});
		mainTargetId = target.targetId;
		const attached = await cdp.send("Target.attachToTarget", {
			targetId: target.targetId,
			flatten: true,
		});
		const pageId: string = attached.sessionId;
		await configure(pageId);
		await cdp.send("Page.enable", {}, pageId);
		const navigation = await cdp.send(
			"Page.navigate",
			{ url: url.href },
			pageId,
		);
		if (navigation.errorText) throw new Error("Page navigation failed");
		// Drain initial resources and then allow asynchronous hydration; bounded by the session deadline.
		await Promise.allSettled([...work]);
		await services.wait(signal);
		await Promise.allSettled([...work]);
		const pages: z.infer<typeof snapshotSchema>[] = [];
		for (const id of [...frames].slice(0, 5)) {
			const result = await cdp
				.send(
					"Runtime.evaluate",
					{ expression: SNAPSHOT, returnByValue: true },
					id,
				)
				.catch((): Params => ({}));
			const parsed = snapshotSchema.safeParse(result.result?.value);
			if (parsed.success && parsed.data.content.trim()) {
				await services.validate(new URL(parsed.data.url));
				pages.push(parsed.data);
			}
		}
		const first = pages[0];
		if (!first) throw new Error("No readable browser content");
		return {
			...first,
			content: pages
				.map((p) => p.content)
				.join("\n\n")
				.slice(0, 16000),
			frameUrls: pages.map((p) => p.url),
			method: "browser-rendered page" as const,
			checkedAt: new Date().toISOString(),
			limitation:
				"Bounded snapshot after JavaScript loading; no logins, clicks or forms. Some widgets may be incomplete. Missing data does not establish why it is unavailable.",
		};
	} finally {
		if (protocol && contextId) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				protocol
					.send("Target.disposeBrowserContext", { browserContextId: contextId })
					.catch(() => {}),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 2000);
				}),
			]);
			clearTimeout(timer);
		}
		protocol?.close();
		if (local) activeLocalReads--;
		if (sessionId)
			await services
				.fetch(`${SESSION_URL}/${sessionId}`, {
					method: "POST",
					headers,
					redirect: "error",
					body: JSON.stringify({ status: "REQUEST_RELEASE" }),
					signal: AbortSignal.timeout(5000),
				})
				.then((r) => r.body?.cancel())
				.catch(() => {});
	}
}

export async function readPublicPage(
	url: string,
	services = browserReaderServices,
) {
	if (browserReadingEnabled()) {
		try {
			return await renderPublicPage(url, services);
		} catch {
			/* Static fallback must not masquerade as rendered evidence. */
		}
	}
	const page = await services.staticRead(url);
	return {
		...page,
		method: "static page text" as const,
		checkedAt: new Date().toISOString(),
		limitation:
			"Browser rendering unavailable or disabled. This fallback does not execute JavaScript; do not claim dynamic content was read.",
	};
}
