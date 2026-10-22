import type { ConversationWebContext } from "../web-conversation.ts";
import type { WebSearchRequest } from "../web-search.ts";
import { commitmentsEnabled } from "./requests.ts";
import { commitments, matchingPreferences, normalizeDomain } from "./store.ts";

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
	if (!domains.length) return web.search(chatId, request);
	// Do not intersect a model-supplied site filter with a different preferred site.
	const query =
		request.query
			.replace(/-?site:[^\s)]+/gi, " ")
			.replace(/\b(?:OR|AND)\b/g, " ")
			.replace(/[()]/g, " ")
			.replace(/\s+/g, " ")
			.trim() || request.query;
	const results: string[] = [];
	for (const domain of domains) {
		try {
			const result = await web.search(chatId, {
				...request,
				query: `site:${domain} ${query}`.slice(0, 400),
			});
			// A site-restricted search is not a visit to the website, and an off-site
			// search result must not masquerade as evidence from the requested source.
			const json = JSON.parse(
				result.replace(
					/^Reused a recent search; no new request was made\.\n/,
					"",
				),
			);
			const sources = Array.isArray(json.sources)
				? json.sources.filter((source: { url?: string }) => {
						try {
							const host = new URL(source.url ?? "").hostname;
							return host === domain || host.endsWith(`.${domain}`);
						} catch {
							return false;
						}
					})
				: [];
			results.push(
				JSON.stringify({
					requestedDomain: domain,
					method: "site-restricted search excerpts, not a full-page visit",
					checkedAt: json.checkedAt,
					sources,
					...(sources.length
						? {}
						: { limitation: "No usable evidence from this domain" }),
				}),
			);
		} catch {
			results.push(
				JSON.stringify({
					requestedDomain: domain,
					limitation:
						"Could not obtain usable search evidence from this domain",
				}),
			);
		}
	}
	try {
		results.push(
			`General search / fallback:\n${await web.search(chatId, { ...request, query })}`,
		);
	} catch {
		results.push("General search unavailable. Do not invent missing results.");
	}
	return results.join("\n\n");
}
