// Sustained Telegram chat-action indicators ("typing…", "recording voice…").
// Telegram expires a chat action after ~5 seconds, so a single send only
// covers fast replies — long operations (LLM generation, transcription,
// image/TTS synthesis) need a refresh loop to keep the indicator visible.
import type { Api, Context } from "grammy";
import { log } from "./logger.ts";

export type ChatAction =
	| "typing"
	| "upload_photo"
	| "record_voice"
	| "upload_voice"
	| "upload_document";

const REFRESH_MS = 4_000;

export interface ChatActionHandle {
	/** Switch the indicator (e.g. typing → record_voice) and resend now. */
	update(action: ChatAction): void;
	/** Stop refreshing. Safe to call more than once. */
	stop(): void;
}

/**
 * Show a chat action immediately and keep it alive until stop() is called.
 * Send failures are swallowed — an indicator must never break the reply flow.
 */
export function startChatAction(
	ctx: Context,
	action: ChatAction,
	refreshMs = REFRESH_MS,
): ChatActionHandle {
	let current = action;
	let stopped = false;

	const send = () => {
		if (stopped) return;
		ctx.replyWithChatAction(current).catch((err) => {
			log.debug("[chat-action] Failed to send action:", err);
		});
	};

	send();
	const interval = setInterval(send, refreshMs);

	return {
		update(next: ChatAction) {
			if (stopped || current === next) return;
			current = next;
			send();
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(interval);
		},
	};
}

/** Run fn while keeping the given chat action alive; always stops after. */
export async function withChatAction<T>(
	ctx: Context,
	action: ChatAction,
	fn: () => Promise<T>,
	refreshMs = REFRESH_MS,
): Promise<T> {
	const handle = startChatAction(ctx, action, refreshMs);
	try {
		return await fn();
	} finally {
		handle.stop();
	}
}

/**
 * Brief "typing…" pulse before a proactive message sent via the raw API
 * (check-ins, follow-ups) — a person types for a moment before hitting send.
 */
export async function pulseTypingBeforeSend(
	api: Api,
	chatId: number,
	durationMs = 1_500 + Math.floor(Math.random() * 1_000),
): Promise<void> {
	try {
		await api.sendChatAction(chatId, "typing");
		await new Promise((resolve) => setTimeout(resolve, durationMs));
	} catch (err) {
		log.debug("[chat-action] Failed to pulse typing:", err);
	}
}
