/**
 * In-memory rate-limit and continuation-window state for group chats.
 * Governs when the bot may reply in a group without being directly
 * addressed: spontaneous replies and continuation
 * windows opened after the bot participates in a conversation.
 */

import { groupPersonalityEnabled } from "./group-personality.ts";

const MINUTE_MS = 60_000;
const GROUP_SPONTANEOUS_DEFAULT_COOLDOWN_MINUTES = 60;
const GROUP_SPONTANEOUS_LEGACY_COOLDOWN_MINUTES = 240;
const GROUP_SPONTANEOUS_ATTEMPT_COOLDOWN_MS = 10 * MINUTE_MS;
const GROUP_CONTINUATION_WINDOW_MS = 15 * MINUTE_MS;
const GROUP_CONTINUATION_MAX_MESSAGES = 6;

const groupAutoReplyTimestamps = new Map<number, number>();
const groupSpontaneousAttemptTimestamps = new Map<number, number>();
const groupContinuationWindows = new Map<
	number,
	{ expiresAt: number; remainingMessages: number }
>();

function groupSpontaneousCooldownMs(): number {
	if (!groupPersonalityEnabled())
		return GROUP_SPONTANEOUS_LEGACY_COOLDOWN_MINUTES * MINUTE_MS;
	const configured = Number(process.env.GROUP_SPONTANEOUS_COOLDOWN_MINUTES);
	const milliseconds = configured * MINUTE_MS;
	if (
		Number.isInteger(configured) &&
		Number.isSafeInteger(milliseconds) &&
		milliseconds > 0
	)
		return milliseconds;
	return GROUP_SPONTANEOUS_DEFAULT_COOLDOWN_MINUTES * MINUTE_MS;
}

export function canAutoReplyInGroup(chatId: number, now = Date.now()): boolean {
	const last = groupAutoReplyTimestamps.get(chatId);
	return last === undefined || now - last >= groupSpontaneousCooldownMs();
}

export function claimGroupSpontaneousReply(
	chatId: number,
	now = Date.now(),
): boolean {
	if (!canAutoReplyInGroup(chatId, now)) return false;
	const lastAttempt = groupSpontaneousAttemptTimestamps.get(chatId);
	if (
		lastAttempt !== undefined &&
		now - lastAttempt < GROUP_SPONTANEOUS_ATTEMPT_COOLDOWN_MS
	)
		return false;
	const personalityEnabled = groupPersonalityEnabled();
	if (personalityEnabled && getActiveContinuationWindow(chatId, now))
		return false;

	groupSpontaneousAttemptTimestamps.set(chatId, now);
	if (!personalityEnabled) registerGroupAutoReply(chatId, now);
	return true;
}

export function registerGroupAutoReply(chatId: number, now = Date.now()): void {
	groupAutoReplyTimestamps.set(chatId, now);
}

export function openGroupContinuationWindow(
	chatId: number,
	now = Date.now(),
): void {
	groupContinuationWindows.set(chatId, {
		expiresAt: now + GROUP_CONTINUATION_WINDOW_MS,
		remainingMessages: GROUP_CONTINUATION_MAX_MESSAGES,
	});
}

function getActiveContinuationWindow(chatId: number, now: number) {
	const window = groupContinuationWindows.get(chatId);
	if (!window || window.expiresAt > now) return window;
	groupContinuationWindows.delete(chatId);
}

export function claimGroupContinuationSlot(
	chatId: number,
	now = Date.now(),
): boolean {
	const window = getActiveContinuationWindow(chatId, now);
	if (!window || window.remainingMessages <= 0) return false;
	window.remainingMessages--;
	return true;
}

/** Clear all in-memory group state (used by tests). */
export function resetGroupState(): void {
	groupAutoReplyTimestamps.clear();
	groupSpontaneousAttemptTimestamps.clear();
	groupContinuationWindows.clear();
}
