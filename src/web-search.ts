import { z } from "zod";

export const webSourceSchema = z.object({
	title: z.string().min(1).max(200),
	url: z
		.url()
		.max(2000)
		.refine((value) => /^https?:\/\//i.test(value)),
	text: z.string().min(1).max(1200),
	published: z.string().max(80).optional(),
});
export type WebSource = z.infer<typeof webSourceSchema>;
export type SearchFreshness = "pd" | "pw" | "pm";
export interface WebSearchRequest {
	query: string;
	freshness?: SearchFreshness;
	news?: boolean;
}

export function isWebSearchEnabled(): boolean {
	return (
		Boolean(process.env.BRAVE_API_KEY?.trim()) &&
		process.env.ENABLE_WEB_SEARCH !== "false"
	);
}

function plainText(value: string, max: number): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

/** Search excerpts are evidence from third parties, never instructions or verified facts. */
export async function searchBrave(
	request: WebSearchRequest,
	options: { fetch?: typeof fetch; apiKey?: string } = {},
): Promise<WebSource[]> {
	const apiKey = options.apiKey ?? process.env.BRAVE_API_KEY?.trim();
	if (!apiKey) throw new Error("Brave search is not configured");
	const query = request.query.trim();
	if (!query || query.length > 400) throw new Error("Invalid search query");
	const url = new URL(
		`https://api.search.brave.com/res/v1/${request.news ? "news" : "web"}/search`,
	);
	url.search = new URLSearchParams({
		q: query,
		count: request.news ? "5" : "3",
		extra_snippets: "true",
		...(request.freshness ? { freshness: request.freshness } : {}),
		...(request.news ? { search_lang: "es" } : {}),
	}).toString();
	const response = await (options.fetch ?? fetch)(url, {
		headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
		signal: AbortSignal.timeout(10_000),
		redirect: "error",
	});
	// Do not expose provider error bodies, request headers, or queries in logs.
	if (!response.ok)
		throw new Error(`Brave search returned HTTP ${response.status}`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty Brave response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 512_000) throw new Error("Brave response exceeds size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const raw = z
		.object({
			web: z.object({ results: z.array(z.unknown()).optional() }).optional(),
			results: z.array(z.unknown()).optional(),
		})
		.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	const resultSchema = z.object({
		title: z.string(),
		url: z.string(),
		description: z.string().optional(),
		extra_snippets: z.array(z.string()).optional(),
		age: z.string().optional(),
		page_age: z.string().optional(),
	});
	const sources: WebSource[] = [];
	for (const value of (request.news ? raw.results : raw.web?.results) ?? []) {
		const parsed = resultSchema.safeParse(value);
		if (!parsed.success) continue;
		const row = parsed.data;
		const source = webSourceSchema.safeParse({
			title: plainText(row.title, 200),
			url: row.url,
			text: plainText(
				[
					...new Set([row.description ?? "", ...(row.extra_snippets ?? [])]),
				].join(" "),
				1200,
			),
			published: (row.page_age ?? row.age)?.slice(0, 80),
		});
		if (source.success && !sources.some((item) => item.url === source.data.url))
			sources.push(source.data);
		if (sources.length === (request.news ? 5 : 3)) break;
	}
	return sources;
}
