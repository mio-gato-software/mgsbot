import { join } from "node:path";
import { z } from "zod";
import { log } from "./logger.ts";
import { readStore, writeStore } from "./memory/storage.ts";
import { memoryPath } from "./runtime-paths.ts";
import {
	isWebSearchEnabled,
	searchBrave,
	type WebSearchRequest,
	webSourceSchema,
} from "./web-search.ts";

const HOUR = 60 * 60 * 1000;
export const WORLD_CONTEXT_TTL_MS = 48 * HOUR;
const entrySchema = z.object({
	query: z.string().max(400),
	freshness: z.enum(["pd", "pw", "pm"]).optional(),
	fetchedAt: z.number().finite().nonnegative(),
	expiresAt: z.number().finite().nonnegative(),
	sources: z.array(webSourceSchema).max(5),
});
const cacheSchema = z.object({
	lastAttemptAt: z.number().finite().nonnegative().default(0),
	entries: z.array(entrySchema).max(5),
});
const budgetSchema = z.object({
	day: z.string(),
	attempts: z.number().int().nonnegative(),
});
type Entry = z.infer<typeof entrySchema>;

export interface WorldContextOptions {
	directory?: string;
	search?: typeof searchBrave;
	now?: () => number;
	enabled?: () => boolean;
	headlinesEnabled?: () => boolean;
	newsQuery?: () => string;
	dailyLimit?: () => number;
}

/** Bounded, expiring reference data. Never passed to semantic-memory promotion. */
export class WorldContextService {
	private readonly directory: string;
	private readonly searchProvider: typeof searchBrave;
	private readonly now: () => number;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: WorldContextOptions = {}) {
		this.directory = options.directory ?? memoryPath("world-context");
		this.searchProvider = options.search ?? searchBrave;
		this.now = options.now ?? Date.now;
	}

	isEnabled(): boolean {
		return (this.options.enabled ?? isWebSearchEnabled)();
	}

	private async serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = this.tail.then(work, work);
		this.tail = next.catch(() => {});
		return next;
	}

	private async load(file: string) {
		const path = join(this.directory, file);
		const cache = await readStore(path, cacheSchema, () => ({
			lastAttemptAt: 0,
			entries: [],
		}));
		const live = cache.entries.filter((entry) => entry.expiresAt > this.now());
		if (live.length !== cache.entries.length) {
			cache.entries = live;
			await writeStore(path, cache, cacheSchema, true);
		}
		return cache;
	}

	private async request(request: WebSearchRequest) {
		const path = join(this.directory, "budget.json");
		const day = new Date(this.now()).toISOString().slice(0, 10);
		const budget = await readStore(path, budgetSchema, () => ({
			day,
			attempts: 0,
		}));
		if (budget.day !== day) {
			budget.day = day;
			budget.attempts = 0;
		}
		const configured =
			this.options.dailyLimit?.() ??
			Number(process.env.WEB_SEARCH_DAILY_LIMIT ?? 30);
		const limit =
			Number.isFinite(configured) && configured >= 0
				? Math.floor(configured)
				: 30;
		if (budget.attempts >= limit)
			throw new Error("Daily web search limit reached");
		// Count attempts before calling: timeouts/restarts must not bypass the limit.
		budget.attempts++;
		await writeStore(path, budget, budgetSchema, true);
		return this.searchProvider(request);
	}

	async refreshHeadlines(): Promise<void> {
		if (
			!this.isEnabled() ||
			!(
				this.options.headlinesEnabled?.() ??
				process.env.ENABLE_NEWS_CONTEXT !== "false"
			)
		)
			return;
		await this.serialized(async () => {
			try {
				const cache = await this.load("headlines.json");
				// Once per 24h, including failed attempts. Shared by all chats and survives restarts.
				if (cache.lastAttemptAt && this.now() - cache.lastAttemptAt < 24 * HOUR)
					return;
				cache.lastAttemptAt = this.now();
				await writeStore(
					join(this.directory, "headlines.json"),
					cache,
					cacheSchema,
					true,
				);
				const query = (
					this.options.newsQuery?.() ??
					process.env.NEWS_CONTEXT_QUERY ??
					"noticias actualidad República Dominicana mundo"
				)
					.trim()
					.slice(0, 400);
				const sources = await this.request({
					query,
					news: true,
					freshness: "pd",
				});
				if (!sources.length) return;
				cache.entries = [
					{
						query,
						sources,
						fetchedAt: this.now(),
						expiresAt: this.now() + WORLD_CONTEXT_TTL_MS,
					},
				];
				await writeStore(
					join(this.directory, "headlines.json"),
					cache,
					cacheSchema,
					true,
				);
			} catch {
				log.warn(
					"[web-context] Could not refresh headlines; conversation continues without new headlines.",
				);
			}
		});
	}

	async context(chatId: number): Promise<string> {
		if (!this.isEnabled()) return "";
		return this.serialized(async () => {
			try {
				const chats = await this.load(`chats/${chatId}.json`);
				const headlines =
					(this.options.headlinesEnabled?.() ??
					process.env.ENABLE_NEWS_CONTEXT !== "false")
						? (await this.load("headlines.json")).entries
						: [];
				// Keep complete records/URLs and reserve room for ambient headlines.
				// Do not let five previously searched topics crowd the daily context out.
				return [
					this.formatContext(chats.entries, headlines.length ? 3500 : 6000),
					this.formatContext(headlines, chats.entries.length ? 2498 : 6000),
				]
					.filter(Boolean)
					.join("\n\n");
			} catch {
				log.warn(
					"[web-context] Could not read temporary context; original files preserved.",
				);
				return "";
			}
		});
	}

	async search(chatId: number, request: WebSearchRequest): Promise<string> {
		if (!this.isEnabled())
			return "Web search is disabled. No search was performed.";
		return this.serialized(async () => {
			try {
				const file = `chats/${chatId}.json`;
				const cache = await this.load(file);
				const query = request.query.trim().slice(0, 400);
				const hit = cache.entries.find(
					(entry) =>
						entry.query.toLocaleLowerCase() === query.toLocaleLowerCase() &&
						entry.freshness === request.freshness &&
						this.now() - entry.fetchedAt < HOUR,
				);
				if (hit)
					return `Reused a recent search; no new request was made.\n${this.format(hit)}`;
				const sources = await this.request({
					query,
					freshness: request.freshness,
				});
				if (!sources.length)
					return "Search completed but returned no usable sources. Do not claim the event was confirmed or disproved.";
				const entry: Entry = {
					query,
					freshness: request.freshness,
					sources,
					fetchedAt: this.now(),
					expiresAt: this.now() + WORLD_CONTEXT_TTL_MS,
				};
				cache.entries = [
					entry,
					...cache.entries.filter(
						(old) =>
							old.query.toLocaleLowerCase() !== query.toLocaleLowerCase(),
					),
				].slice(0, 5);
				try {
					await writeStore(
						join(this.directory, file),
						cache,
						cacheSchema,
						true,
					);
				} catch {
					log.warn(
						"[web-context] Search succeeded but temporary context could not be saved.",
					);
				}
				return this.format(entry);
			} catch {
				log.warn("[web-context] Search unavailable or daily limit reached.");
				return "Web search could not be completed (service unavailable or daily limit reached). Say you could not verify it; do not invent results or claim to have read sources.";
			}
		});
	}

	private formatContext(entries: Entry[], budget: number): string {
		const sections: string[] = [];
		for (const entry of entries) {
			const remaining =
				budget - sections.join("\n\n").length - (sections.length ? 2 : 0);
			const sources = [...entry.sources];
			// If source URLs are unusually long, omit whole sources rather than
			// clipping the JSON or producing a misleading partial citation.
			while (sources.length) {
				const text = this.format({ ...entry, sources }, true);
				if (text.length <= remaining) {
					sections.push(text);
					break;
				}
				sources.pop();
			}
		}
		return sections.join("\n\n");
	}

	private format(entry: Entry, compact = false): string {
		return JSON.stringify({
			query: entry.query,
			checkedAt: new Date(entry.fetchedAt).toISOString(),
			expiresAt: new Date(entry.expiresAt).toISOString(),
			sources: entry.sources.map((source) => ({
				...source,
				text: source.text.slice(0, compact ? 180 : 1200),
			})),
		});
	}
}

export const worldContext = new WorldContextService();
