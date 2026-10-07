import {
	type ClientRequest,
	request as httpRequest,
	type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface PublicAddress {
	address: string;
	family: 4 | 6;
}

export const WEB_REQUEST_HEADERS = {
	Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
	"Accept-Encoding": "identity",
	"User-Agent":
		"Mozilla/5.0 (compatible; MGSBot/1.0; +https://github.com/eliaquin/mgsbot)",
};

type Request = (
	url: URL,
	options: RequestOptions,
	callback: (response: IncomingMessage) => void,
) => ClientRequest;

/** Connect to a checked numeric address; HTTP Host and TLS verification keep the original hostname. */
export async function requestPinnedWebPage(
	url: URL,
	addresses: PublicAddress[],
	signal: AbortSignal,
	request: Request = url.protocol === "https:" ? httpsRequest : httpRequest,
): Promise<Response> {
	let lastError: unknown = new Error("No public address available");
	// Prefer IPv4, but retry only the already-validated addresses on connection failure.
	for (const address of [...addresses].sort((a, b) => a.family - b.family)) {
		signal.throwIfAborted();
		try {
			return await new Promise<Response>((resolve, reject) => {
				const hostname = url.hostname.replace(/^\[|\]$/g, "");
				const req = request(
					url,
					{
						hostname: address.address,
						family: address.family,
						servername: isIP(hostname) ? "" : hostname,
						headers: { ...WEB_REQUEST_HEADERS, Host: url.host },
						agent: false,
						signal,
						maxHeaderSize: 16_384,
					},
					(incoming) => {
						try {
							const headers = new Headers();
							for (const [name, value] of Object.entries(incoming.headers)) {
								if (value !== undefined)
									headers.set(
										name,
										Array.isArray(value) ? value.join(", ") : value,
									);
							}
							const status = incoming.statusCode ?? 502;
							if ([204, 205, 304].includes(status)) incoming.destroy();
							resolve(
								new Response(
									[204, 205, 304].includes(status)
										? null
										: (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
									{
										status,
										statusText: incoming.statusMessage,
										headers,
									},
								),
							);
						} catch (error) {
							incoming.destroy();
							reject(error);
						}
					},
				);
				req.once("error", reject);
				req.end();
			});
		} catch (error) {
			signal.throwIfAborted();
			lastError = error;
		}
	}
	throw lastError;
}
