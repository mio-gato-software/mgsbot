import { log } from "./logger.ts";

type AlertSink = (text: string) => Promise<void>;

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_TRACKED_KEYS = 100;
const MAX_MESSAGE_CHARS = 400;

let sink: AlertSink | null = null;
const lastSentAt = new Map<string, number>();

/** Register the delivery function (e.g. a Telegram DM to the owner). */
export function setAlertSink(fn: AlertSink | null): void {
	sink = fn;
}

/** Test hook: clear cooldown state. */
export function resetAlertState(): void {
	lastSentAt.clear();
}

/** Short, key-safe summary of an unknown error: name + message, no stack. */
export function errorSummary(error: unknown): string {
	const text =
		error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.length > MAX_MESSAGE_CHARS
		? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
		: text;
}

/**
 * Send an owner alert through the configured sink, rate-limited per key.
 * No-op when no sink is set. Never throws.
 */
export async function alertOwner(
	key: string,
	message: string,
	cooldownMs = DEFAULT_COOLDOWN_MS,
): Promise<void> {
	if (!sink) return;
	const now = Date.now();
	const last = lastSentAt.get(key);
	if (last !== undefined && now - last < cooldownMs) return;
	lastSentAt.set(key, now);
	if (lastSentAt.size > MAX_TRACKED_KEYS) {
		const oldest = lastSentAt.keys().next().value;
		if (oldest !== undefined) lastSentAt.delete(oldest);
	}
	try {
		await sink(`[alert:${key}] ${message}`);
	} catch (error) {
		log.error("[alerts] Failed to deliver owner alert:", error);
	}
}
