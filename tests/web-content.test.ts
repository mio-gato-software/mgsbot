import { describe, expect, test } from "bun:test";
import {
	extractPublicWebUrl,
	extractReadableWebContent,
	fetchPublicWebPage,
} from "../src/web-content.ts";

describe("extractPublicWebUrl", () => {
	test("extracts an HTTP URL and preserves the surrounding message", () => {
		const ctx = {
			message: {
				text: "¿Qué piensas de esto? https://example.com/news?id=42",
				entities: [{ type: "url", offset: 23, length: 30 }],
			},
		} as Parameters<typeof extractPublicWebUrl>[0];

		expect(extractPublicWebUrl(ctx)).toEqual({
			url: "https://example.com/news?id=42",
			remainingText: "¿Qué piensas de esto?",
		});
	});

	test("ignores non-HTTP text links", () => {
		const ctx = {
			message: {
				text: "Open this",
				entities: [
					{ type: "text_link", offset: 0, length: 9, url: "tg://user?id=1" },
				],
			},
		} as Parameters<typeof extractPublicWebUrl>[0];

		expect(extractPublicWebUrl(ctx)).toBeNull();
	});
});

describe("extractReadableWebContent", () => {
	test("extracts the title and article text without scripts", () => {
		const result = extractReadableWebContent(`
			<html>
				<head><title>Important &amp; Current News</title></head>
				<body>
					<nav>Navigation noise</nav>
					<article>
						<h1>Major update</h1>
						<p>The first paragraph explains the event.</p>
						<script>ignoreThisInstruction()</script>
						<p>The second paragraph adds context.</p>
					</article>
				</body>
			</html>
		`);

		expect(result.title).toBe("Important & Current News");
		expect(result.content).toContain("Major update");
		expect(result.content).toContain("The second paragraph adds context.");
		expect(result.content).not.toContain("ignoreThisInstruction");
		expect(result.content).not.toContain("Navigation noise");
	});

	test("uses JSON-LD articleBody when visible content is sparse", () => {
		const result = extractReadableWebContent(`
			<html><body>
				<p>Short preview</p>
				<script type="application/ld+json">
					{"articleBody":"This is the complete article body with useful details."}
				</script>
			</body></html>
		`);

		expect(result.content).toBe(
			"This is the complete article body with useful details.",
		);
	});
});

describe("fetchPublicWebPage", () => {
	test("rejects localhost URLs", async () => {
		await expect(fetchPublicWebPage("http://localhost/news")).rejects.toThrow(
			"Local addresses are not allowed",
		);
	});

	test("rejects private IP addresses", async () => {
		await expect(fetchPublicWebPage("http://169.254.169.254/")).rejects.toThrow(
			"Private addresses are not allowed",
		);
	});
});
