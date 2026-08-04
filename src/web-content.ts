import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Context } from "grammy";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONTENT_CHARS = 16_000;
const REQUEST_TIMEOUT_MS = 15_000;
const WEB_URL_REGEX = /https?:\/\/[^\s<>"']+/giu;

export interface PublicWebLink {
	url: string;
	remainingText: string;
}

export interface PublicWebPage {
	url: string;
	title?: string;
	content: string;
}

function trimUrlPunctuation(value: string): string {
	return value.replace(/[.,!?;:)}\]]+$/u, "");
}

function parseHttpUrl(value: string): URL | null {
	try {
		const url = new URL(trimUrlPunctuation(value));
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		return url;
	} catch {
		return null;
	}
}

export function extractPublicWebUrl(ctx: Context): PublicWebLink | null {
	const text = ctx.message?.text ?? "";
	const entities = ctx.message?.entities ?? [];

	for (const entity of entities) {
		if (entity.type !== "url" && entity.type !== "text_link") continue;
		const rawUrl =
			entity.type === "text_link"
				? (entity.url ?? "")
				: text.slice(entity.offset, entity.offset + entity.length);
		const url = parseHttpUrl(rawUrl);
		if (!url) continue;

		const remainingText =
			entity.type === "text_link"
				? text.trim()
				: `${text.slice(0, entity.offset)}${text.slice(entity.offset + entity.length)}`.trim();
		return { url: url.href, remainingText };
	}

	for (const match of text.matchAll(WEB_URL_REGEX)) {
		const rawUrl = match[0];
		const url = parseHttpUrl(rawUrl);
		if (!url) continue;
		const start = match.index;
		const remainingText =
			`${text.slice(0, start)}${text.slice(start + rawUrl.length)}`.trim();
		return { url: url.href, remainingText };
	}

	return null;
}

function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	const first = parts[0] ?? 0;
	const second = parts[1] ?? 0;
	const third = parts[2] ?? 0;

	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 0 && third === 0) ||
		(first === 192 && second === 0 && third === 2) ||
		(first === 192 && second === 88 && third === 99) ||
		(first === 192 && second === 168) ||
		(first === 198 && (second === 18 || second === 19)) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113) ||
		first >= 224
	);
}

function mappedIpv4FromIpv6(address: string): string | null {
	const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	const dottedMatch = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/u);
	if (dottedMatch?.[1]) return dottedMatch[1];

	const hexMatch = normalized.match(
		/(?:^|:)ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u,
	);
	if (!hexMatch?.[1] || !hexMatch[2]) return null;
	const high = Number.parseInt(hexMatch[1], 16);
	const low = Number.parseInt(hexMatch[2], 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateIpv6(address: string): boolean {
	const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (/^fe[89ab]/u.test(normalized)) return true;
	if (normalized.startsWith("ff")) return true;
	if (normalized.startsWith("2001:db8:")) return true;

	const mappedIpv4 = mappedIpv4FromIpv6(normalized);
	return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

function isPrivateIpAddress(address: string): boolean {
	const version = isIP(address.replace(/^\[|\]$/g, ""));
	if (version === 4) return isPrivateIpv4(address);
	if (version === 6) return isPrivateIpv6(address);
	return true;
}

async function assertPublicUrl(url: URL): Promise<void> {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (
		!hostname ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost")
	) {
		throw new Error("Local addresses are not allowed");
	}

	if (isIP(hostname)) {
		if (isPrivateIpAddress(hostname)) {
			throw new Error("Private addresses are not allowed");
		}
		return;
	}

	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => isPrivateIpAddress(address))
	) {
		throw new Error("URL does not resolve to a public address");
	}
}

async function readLimitedBody(response: Response): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
		throw new Error("Web page is too large");
	}

	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("Web page is too large");
		}
		chunks.push(value);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function decodeHtmlEntities(value: string): string {
	const namedEntities: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: '"',
	};

	return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code) => {
		if (code.startsWith("#x")) {
			return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
		}
		if (code.startsWith("#")) {
			return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
		}
		return namedEntities[code.toLowerCase()] ?? entity;
	});
}

function htmlToText(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<!--[\s\S]*?-->/gu, " ")
			.replace(
				/<(?:script|style|noscript|svg|template|form)[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template|form)>/giu,
				" ",
			)
			.replace(/<br\s*\/?\s*>/giu, "\n")
			.replace(/<\/(?:p|div|section|article|main|li|h[1-6])>/giu, "\n")
			.replace(/<[^>]+>/gu, " "),
	)
		.replace(/[\t\f\v ]+/gu, " ")
		.replace(/ *\n */gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function extractTitle(html: string): string | undefined {
	const openGraphTitle = html.match(
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/iu,
	)?.[1];
	const title =
		openGraphTitle ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
	return title ? htmlToText(title).slice(0, 300) : undefined;
}

export function extractReadableWebContent(html: string): {
	title?: string;
	content: string;
} {
	const title = extractTitle(html);
	const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/iu)?.[1];
	const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1];
	let content = htmlToText(article ?? main ?? html);

	if (content.length < 300) {
		const articleBody = html.match(
			/["']articleBody["']\s*:\s*("(?:\\.|[^"\\])*")/iu,
		)?.[1];
		if (articleBody) {
			try {
				const structuredContent = JSON.parse(articleBody) as string;
				if (structuredContent.length > content.length)
					content = structuredContent;
			} catch {
				// Ignore malformed structured data and keep the visible page text.
			}
		}
	}

	return { title, content: content.slice(0, MAX_CONTENT_CHARS) };
}

export async function fetchPublicWebPage(
	rawUrl: string,
): Promise<PublicWebPage> {
	let url = parseHttpUrl(rawUrl);
	if (!url) throw new Error("Invalid public web URL");

	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		await assertPublicUrl(url);
		const response = await fetch(url, {
			headers: {
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
				"User-Agent":
					"Mozilla/5.0 (compatible; MGSBot/1.0; +https://github.com/eliaquin/mgsbot)",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("Redirect has no destination");
			url = new URL(location, url);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error("Unsupported redirect protocol");
			}
			continue;
		}

		if (!response.ok) {
			throw new Error(`Web page returned HTTP ${response.status}`);
		}

		const contentType =
			response.headers.get("content-type")?.toLowerCase() ?? "";
		if (
			!contentType.includes("text/html") &&
			!contentType.includes("application/xhtml+xml") &&
			!contentType.includes("text/plain")
		) {
			throw new Error("URL is not an HTML or text page");
		}

		const html = await readLimitedBody(response);
		const page = extractReadableWebContent(html);
		if (!page.content) throw new Error("No readable content found on web page");
		return { url: url.href, ...page };
	}

	throw new Error("Too many redirects");
}
