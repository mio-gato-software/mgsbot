import { AsyncLocalStorage } from "node:async_hooks";

export const REQUEST_TIMEOUT_MS = 30_000;
export const CHAT_TIMEOUT_MS = 60_000;
export const EMBEDDING_TIMEOUT_MS = 20_000;
export const BACKGROUND_TIMEOUT_MS = 120_000;
export const UPDATE_TIMEOUT_MS = 360_000;

const operations = new AsyncLocalStorage<AbortSignal>();
const retryOwners = new AsyncLocalStorage<boolean>();
const active = new Set<AbortController>();

export class OperationTimeoutError extends Error {
	constructor(operation: string) {
		super(`${operation} timed out`);
		this.name = "TimeoutError";
	}
}

export function isTimeoutError(error: unknown): boolean {
	const seen = new Set<Error>();
	while (error instanceof Error && !seen.has(error)) {
		seen.add(error);
		if (
			error.name === "TimeoutError" ||
			error.name === "APIConnectionTimeoutError" ||
			/timed out|timeout/i.test(error.message)
		)
			return true;
		error = error.cause;
	}
	return false;
}

export function currentOperationSignal(): AbortSignal | undefined {
	return operations.getStore();
}

export function combineOperationSignal(
	signal?: AbortSignal | null,
): AbortSignal {
	const parent = currentOperationSignal();
	return parent && signal
		? AbortSignal.any([parent, signal])
		: (parent ?? signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS));
}

export function requestSignal(timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
	return combineOperationSignal(AbortSignal.timeout(timeoutMs));
}

/** Also releases callers when an injected or third-party operation ignores cancellation. */
export function abortable<T>(
	work: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", aborted));
	});
}

export async function withDeadline<T>(
	operation: string,
	timeoutMs: number,
	work: () => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const signal = combineOperationSignal(controller.signal);
	const timer = setTimeout(
		() => controller.abort(new OperationTimeoutError(operation)),
		timeoutMs,
	);
	active.add(controller);
	try {
		signal.throwIfAborted();
		return await operations.run(signal, () =>
			abortable(Promise.resolve().then(work), signal),
		);
	} finally {
		clearTimeout(timer);
		active.delete(controller);
	}
}

export function cancelActiveOperations(): void {
	for (const controller of active)
		controller.abort(new DOMException("Bot shutting down", "AbortError"));
}

export function ownsRetryBudget(): boolean {
	return retryOwners.getStore() === true;
}

export function abortableDelay(
	milliseconds: number,
	signal = currentOperationSignal(),
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const cancel = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason);
		};
		const cleanup = () => signal?.removeEventListener("abort", cancel);
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
	});
}

export function withRetryBudget<T>(work: () => Promise<T>): Promise<T> {
	return retryOwners.run(true, work);
}

/** SDKs call this at request time, so a cached client inherits the current deadline. */
export function operationFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const signal = combineOperationSignal(
		init?.signal ?? (input instanceof Request ? input.signal : undefined),
	);
	signal.throwIfAborted();
	return fetch(input, {
		...init,
		signal,
	}).catch((error) => {
		signal.throwIfAborted();
		throw error;
	});
}
