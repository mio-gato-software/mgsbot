/** Optional renderer selection. No browser is installed or started by the bot. */
export function browserProvider(): "local" | "browserbase" | "none" {
	if (process.env.ENABLE_BROWSER_READING === "false") return "none";
	const configured = process.env.BROWSER_PROVIDER?.trim();
	if (
		configured === "local" ||
		configured === "browserbase" ||
		configured === "none"
	)
		return configured;
	if (configured) throw new Error("Invalid BROWSER_PROVIDER configuration");
	return process.env.BROWSERBASE_API_KEY?.trim() ? "browserbase" : "none";
}

/** Local rendering also uses direct HTTP for previews/fallbacks, without billed Fetch calls. */
export function useBrowserbaseFetch(): boolean {
	return process.env.BROWSER_PROVIDER?.trim() !== "local";
}

export function localBrowserEndpoint(raw: string): URL {
	const url = new URL(raw);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error(
			"LOCAL_BROWSER_CDP_URL must be a loopback HTTP origin with an explicit port",
		);
	return url;
}

export function localBrowserSocket(raw: string, origin: URL): string {
	const url = new URL(raw);
	if (
		url.protocol !== "ws:" ||
		url.hostname !== origin.hostname ||
		url.port !== origin.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.pathname.startsWith("/devtools/browser/")
	)
		throw new Error("Unexpected local browser endpoint");
	return url.href;
}
