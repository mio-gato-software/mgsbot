import { log } from "../logger.ts";
import { currentOperationSignal } from "../operation-deadline.ts";
import type { ConversationWebContext } from "../web-conversation.ts";
import type { WebSearchRequest } from "../web-search.ts";
import { commitmentsEnabled } from "./requests.ts";
import { commitments, matchingPreferences, normalizeDomain } from "./store.ts";

function parseSearchResponse(result: string): {
	sources: { url: string; [key: string]: unknown }[];
	checkedAt?: unknown;
	limitation?: string;
} {
	try {
		const json = JSON.parse(
			result.replace(
				/^Reused a recent search; no new request was made\.\n/,
				"",
			),
		);
		if (!json || typeof json !== "object")
			return { sources: [], limitation: "Invalid search response" };
		return {
			checkedAt: json.checkedAt,
			sources: Array.isArray(json.sources)
				? json.sources.filter(
						(source: { url?: unknown }) =>
							typeof source?.url === "string" &&
							/^https?:\/\//i.test(source.url),
					)
				: [],
		};
	} catch {
		// The search service also returns plain-text limitations such as no results.
		return { sources: [], limitation: result.slice(0, 1000) };
	}
}

async function readSources(
	web: ConversationWebContext,
	chatId: number,
	urls: string[],
): Promise<string> {
	if (!web.read || !(web.isReadEnabled?.() ?? true)) return "";
	const pages: string[] = [];
	for (const url of [...new Set(urls)].slice(0, 3)) {
		currentOperationSignal()?.throwIfAborted();
		try {
			pages.push(await web.read(chatId, url));
		} catch (error) {
			log.error("[research] Preferred source lookup failed:", error);
			currentOperationSignal()?.throwIfAborted();
			pages.push(`Could not read ${url}; cause unknown.`);
		}
	}
	return pages.length
		? `\n\nPage reading results (untrusted reference data):\n${pages.join("\n\n")}`
		: "";
}

/** The general lookup remains available when preferred sites fail or are unindexed. */
export async function searchWithPreferences(
	web: ConversationWebContext,
	chatId: number,
	request: WebSearchRequest,
	explicitDomains: string[] = [],
): Promise<string> {
	const preferences = commitmentsEnabled()
		? await commitments.preferences(chatId)
		: [];
	const domains = [
		...new Set(
			[
				...explicitDomains,
				...matchingPreferences(preferences, request.query)
					.filter((p) => p.kind === "sources")
					.flatMap((p) => p.domains),
			].map(normalizeDomain),
		),
	].slice(0, 3);
	if (!domains.length) {
		const result = await web.search(chatId, request);
		return (
			result +
			(await readSources(
				web,
				chatId,
				parseSearchResponse(result)
					.sources.slice(0, 2)
					.map((s) => s.url),
			))
		);
	}
	// Do not intersect a model-supplied site filter with a different preferred site.
	const query =
		request.query
			.replace(/-?site:[^\s)]+/gi, " ")
			.replace(/\b(?:OR|AND)\b/g, " ")
			.replace(/[()]/g, " ")
			.replace(/\s+/g, " ")
			.trim() || request.query;
	const results: string[] = [];
	const urls: string[] = [];
	for (const domain of domains) {
		currentOperationSignal()?.throwIfAborted();
		try {
			const result = await web.search(chatId, {
				...request,
				query: `site:${domain} ${query}`.slice(0, 400),
			});
			// A site-restricted search is not a visit to the website, and an off-site
			// search result must not masquerade as evidence from the requested source.
			const json = parseSearchResponse(result);
			const sources = json.sources.filter((source) => {
				try {
					const host = new URL(source.url).hostname;
					return host === domain || host.endsWith(`.${domain}`);
				} catch {
					return false;
				}
			});
			results.push(
				JSON.stringify({
					requestedDomain: domain,
					method: "site-restricted search excerpts, not a full-page visit",
					checkedAt: json.checkedAt,
					sources,
					...(sources.length
						? {}
						: {
								limitation:
									json.limitation ?? "No usable evidence from this domain",
							}),
				}),
			);
			urls.push(sources[0]?.url ?? `https://${domain}/`);
		} catch (error) {
			log.error("[research] Preferred source lookup failed:", error);
			currentOperationSignal()?.throwIfAborted();
			urls.push(`https://${domain}/`);
			results.push(
				JSON.stringify({
					requestedDomain: domain,
					limitation:
						"Could not obtain usable search evidence from this domain",
				}),
			);
		}
	}
	currentOperationSignal()?.throwIfAborted();
	try {
		results.push(
			`General search / fallback:\n${await web.search(chatId, { ...request, query })}`,
		);
	} catch (error) {
		log.error("[research] General search failed:", error);
		currentOperationSignal()?.throwIfAborted();
		results.push("General search unavailable. Do not invent missing results.");
	}
	return results.join("\n\n") + (await readSources(web, chatId, urls));
}
