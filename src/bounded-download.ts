export class DownloadSizeError extends Error {
	constructor(label: string) {
		super(`${label} is too large`);
		this.name = "DownloadSizeError";
	}
}

export async function readBoundedDownload(
	response: Response,
	maxBytes: number,
	label: string,
): Promise<Buffer> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new DownloadSizeError(label);
	}
	if (!response.body) return Buffer.alloc(0);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks, total);
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new DownloadSizeError(label);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
}
