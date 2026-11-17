import { readBoundedDownload } from "./bounded-download.ts";

const MAX_FAL_ASSET_BYTES = 32 * 1024 * 1024;

export async function downloadFalAsset(
	rawUrl: string,
	kind: "image" | "audio",
	signal: AbortSignal,
): Promise<Buffer> {
	let url = new URL(rawUrl);
	for (let redirects = 0; redirects <= 3; redirects++) {
		if (
			url.protocol !== "https:" ||
			url.port ||
			url.username ||
			url.password ||
			(url.hostname !== "fal.media" && !url.hostname.endsWith(".fal.media"))
		)
			throw new Error("Unexpected fal media destination");
		const response = await fetch(url, { signal, redirect: "manual" });
		if (response.ok)
			return readBoundedDownload(response, MAX_FAL_ASSET_BYTES, `fal ${kind}`);
		await response.body?.cancel().catch(() => {});
		const location = response.headers.get("location");
		if (![301, 302, 303, 307, 308].includes(response.status) || !location)
			throw new Error(`Failed to download fal ${kind}: ${response.status}`);
		url = new URL(location, url);
	}
	throw new Error("Too many redirects downloading fal media");
}
