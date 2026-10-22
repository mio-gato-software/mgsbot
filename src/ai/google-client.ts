import { GoogleGenAI } from "@google/genai";
import { operationFetch, REQUEST_TIMEOUT_MS } from "../operation-deadline.ts";

export function createGoogleClient(
	apiKey?: string,
	timeoutMs = REQUEST_TIMEOUT_MS,
): GoogleGenAI {
	return new GoogleGenAI({
		...(apiKey ? { apiKey } : {}),
		httpOptions: {
			timeout: timeoutMs,
			retryOptions: { attempts: 1 },
			fetch: operationFetch,
		},
	});
}
