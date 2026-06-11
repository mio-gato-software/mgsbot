/**
 * In-memory rate-limit and continuation-window state for group chats.
 * Governs when the bot may reply in a group without being directly
 * addressed: spontaneous replies (heavily rate-limited) and continuation
 * windows opened after the bot participates in a conversation.
 */

const GROUP_SPONTANEOUS_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const GROUP_SPONTANEOUS_EVALUATION_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_SPONTANEOUS_REPLIES_PER_WINDOW = 1;
const GROUP_CONTINUATION_WINDOW_MS = 15 * 60 * 1000;
const GROUP_CONTINUATION_MAX_MESSAGES = 6;

const groupAutoReplyTimestamps = new Map<number, number[]>();
const groupSpontaneousEvaluationTimestamps = new Map<number, number>();
const groupContinuationWindows = new Map<
	number,
	{ expiresAt: number; remainingMessages: number }
>();

export function canAutoReplyInGroup(chatId: number, now = Date.now()): boolean {
	const recent = (groupAutoReplyTimestamps.get(chatId) ?? []).filter(
		(ts) => now - ts <= GROUP_SPONTANEOUS_COOLDOWN_MS,
	);
	const last = recent[recent.length - 1];
	if (last && now - last < GROUP_SPONTANEOUS_COOLDOWN_MS) {
		groupAutoReplyTimestamps.set(chatId, recent);
		return false;
	}
	if (recent.length >= MAX_SPONTANEOUS_REPLIES_PER_WINDOW) {
		groupAutoReplyTimestamps.set(chatId, recent);
		return false;
	}
	return true;
}

export function canEvaluateSpontaneousReplyInGroup(
	chatId: number,
	now = Date.now(),
): boolean {
	const last = groupSpontaneousEvaluationTimestamps.get(chatId);
	return !last || now - last >= GROUP_SPONTANEOUS_EVALUATION_COOLDOWN_MS;
}

export function registerSpontaneousReplyEvaluation(
	chatId: number,
	now = Date.now(),
): void {
	groupSpontaneousEvaluationTimestamps.set(chatId, now);
}

export function registerGroupAutoReply(chatId: number, now = Date.now()): void {
	const recent = (groupAutoReplyTimestamps.get(chatId) ?? []).filter(
		(ts) => now - ts <= GROUP_SPONTANEOUS_COOLDOWN_MS,
	);
	recent.push(now);
	groupAutoReplyTimestamps.set(chatId, recent);
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

export function claimGroupContinuationSlot(
	chatId: number,
	now = Date.now(),
): boolean {
	const window = groupContinuationWindows.get(chatId);
	if (!window || window.expiresAt <= now || window.remainingMessages <= 0) {
		groupContinuationWindows.delete(chatId);
		return false;
	}

	window.remainingMessages--;
	if (window.remainingMessages <= 0) {
		groupContinuationWindows.delete(chatId);
	} else {
		groupContinuationWindows.set(chatId, window);
	}
	return true;
}

/** Clear all in-memory group state (used by tests). */
export function resetGroupState(): void {
	groupAutoReplyTimestamps.clear();
	groupSpontaneousEvaluationTimestamps.clear();
	groupContinuationWindows.clear();
}
