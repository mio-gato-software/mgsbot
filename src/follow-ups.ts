import type { Api } from "grammy";
import { generateResponse } from "./ai/core.ts";
import { extractFollowUps } from "./ai/evaluation.ts";
import { trackBackground } from "./background-tasks.ts";
import { botNow, clampToReasonableHours, formatDateTime } from "./bot-time.ts";
import { pulseTypingBeforeSend } from "./chat-actions.ts";
import { log } from "./logger.ts";
import {
	addMessageToSensory,
	computeTextScore,
	loadSensory,
	withChatLock,
	withFollowUpsLock,
} from "./memory/index.ts";
import { drainPromotionSpool } from "./memory/promotion.ts";
import { followUpsSchema } from "./memory/schemas.ts";
import { readStore, writeStore } from "./memory/storage.ts";
import type { ChatMessage } from "./providers/types.ts";
import { memoryPath } from "./runtime-paths.ts";
import type { ConversationMessage, FollowUp } from "./types.ts";

export const FOLLOW_UPS_PATH = memoryPath("follow-ups.json");

const MAX_PENDING = 5;
const MAX_SENDS_PER_DAY = 2;
const COOLDOWN_BETWEEN_SENDS_MS = 2 * 60 * 60 * 1000; // 2 hours
const EXPIRATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_ATTEMPTS = 3;
export const ACTIVE_CONVERSATION_MS = 15 * 60 * 1000; // 15 minutes
const TOPIC_RESOLVED_THRESHOLD = 0.3;
// A detected event similar to any follow-up tracked within this window is a
// rehash, not news — without this the same topic gets re-detected from memory
// for weeks (e.g. the same dinner plan resurfacing in every conversation).
export const EVENT_DEDUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// --- Storage ---

export async function loadFollowUps(): Promise<FollowUp[]> {
	return readStore(FOLLOW_UPS_PATH, followUpsSchema, () => []);
}

export async function saveFollowUps(followUps: FollowUp[]): Promise<void> {
	await writeStore(FOLLOW_UPS_PATH, followUps, followUpsSchema, true);
}

/**
 * True when the event matches any follow-up tracked in the recent window,
 * regardless of status — a sent, cancelled, or expired follow-up on the same
 * topic means bringing it up again would feel like nagging, not interest.
 */
export function isDuplicateOfRecentFollowUp(
	all: FollowUp[],
	event: string,
	now = Date.now(),
): boolean {
	const cutoff = now - EVENT_DEDUP_WINDOW_MS;
	return all.some(
		(fu) =>
			Math.max(fu.detectedAt, fu.sentAt ?? 0) >= cutoff &&
			computeTextScore(fu.event, event) >= TOPIC_RESOLVED_THRESHOLD,
	);
}

/**
 * Events of any follow-up tracked in the window — used by check-ins as
 * stale topics the proactive generator must not bring up again.
 */
export async function getRecentFollowUpEvents(
	windowMs = EVENT_DEDUP_WINDOW_MS,
): Promise<string[]> {
	const all = await loadFollowUps();
	const cutoff = Date.now() - windowMs;
	return all
		.filter((fu) => Math.max(fu.detectedAt, fu.sentAt ?? 0) >= cutoff)
		.map((fu) => fu.event);
}

export async function addFollowUp(
	followUp: Omit<FollowUp, "id" | "status" | "attempts">,
): Promise<boolean> {
	return withFollowUpsLock(async () => {
		const all = await loadFollowUps();
		const pending = all.filter((fu) => fu.status === "pending");

		if (pending.length >= MAX_PENDING) {
			log.debug("[follow-ups] Max pending reached, skipping new follow-up");
			return false;
		}

		if (isDuplicateOfRecentFollowUp(all, followUp.event)) {
			log.debug(
				`[follow-ups] Skipping duplicate of recent topic: "${followUp.event}"`,
			);
			return false;
		}

		const newFollowUp: FollowUp = {
			...followUp,
			id: `fu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			status: "pending",
			attempts: 0,
		};

		all.push(newFollowUp);
		await saveFollowUps(all);

		log.debug(
			`[follow-ups] Added: "${newFollowUp.event}" scheduled for ${new Date(newFollowUp.scheduledFor).toISOString()}`,
		);
		return true;
	});
}

// --- Scheduling ---

export { clampToReasonableHours } from "./bot-time.ts";

// --- Expiration ---

// Mutates the given array; caller persists (inside the follow-ups lock).
function expireStaleFollowUps(all: FollowUp[]): boolean {
	const now = Date.now();
	let changed = false;

	for (const fu of all) {
		if (fu.status === "pending" && now - fu.scheduledFor > EXPIRATION_MS) {
			fu.status = "expired";
			changed = true;
			log.debug(`[follow-ups] Expired: "${fu.event}"`);
		}
	}

	return changed;
}

// --- Rate Limiting ---

// Legacy entries predate sentAt; scheduledFor is the closest proxy for them.
function sentAtOf(fu: FollowUp): number {
	return fu.sentAt ?? fu.scheduledFor;
}

export function getSendsToday(all: FollowUp[]): number {
	const todayMs = botNow().startOf("day").valueOf();

	return all.filter((fu) => fu.status === "sent" && sentAtOf(fu) > todayMs)
		.length;
}

export function getLastSendTime(all: FollowUp[]): number {
	let lastSent = 0;
	for (const fu of all) {
		if (fu.status === "sent" && sentAtOf(fu) > lastSent) {
			lastSent = sentAtOf(fu);
		}
	}
	return lastSent;
}

export async function wasFollowUpSentToday(): Promise<boolean> {
	return getSendsToday(await loadFollowUps()) > 0;
}

// --- Cancellation ---

export async function checkAndCancelResolvedFollowUps(
	chatId: number,
	userContent: string,
): Promise<void> {
	await withFollowUpsLock(async () => {
		const all = await loadFollowUps();
		const pending = all.filter(
			(fu) => fu.status === "pending" && fu.chatId === chatId,
		);

		if (pending.length === 0) return;

		let changed = false;
		for (const fu of pending) {
			const score = computeTextScore(fu.event, userContent);
			if (score >= TOPIC_RESOLVED_THRESHOLD) {
				fu.status = "cancelled";
				changed = true;
				log.debug(
					`[follow-ups] Cancelled (user mentioned topic, score=${score.toFixed(2)}): "${fu.event}"`,
				);
			}
		}

		if (changed) await saveFollowUps(all);
	});
}

// --- Follow-up message generation ---

async function generateFollowUpMessage(followUp: FollowUp): Promise<string> {
	const systemPrompt =
		"You are a casual friend. Generate a natural, brief variation of the given question, in the same language as the question. Don't explain anything — respond only with the varied question.";
	const messages: ChatMessage[] = [
		{ role: "user", content: followUp.followUpQuestion },
	];
	return generateResponse(systemPrompt, messages);
}

// --- Main checker (called from setInterval) ---

export async function checkAndSendFollowUps(
	api: Api,
	isBotOff: () => boolean,
	isSleepingHour: () => boolean,
): Promise<void> {
	if (process.env.ENABLE_FOLLOW_UPS !== "true") return;
	if (isBotOff()) return;
	if (isSleepingHour()) return;

	// Hold the follow-ups lock for the whole cycle so message-path writers
	// (addFollowUp, checkAndCancelResolvedFollowUps) queue behind it instead
	// of clobbering the status changes made here.
	await withFollowUpsLock(async () => {
		const all = await loadFollowUps();
		const now = Date.now();
		let expired = expireStaleFollowUps(all);

		// Rate limits
		if (getSendsToday(all) >= MAX_SENDS_PER_DAY) {
			if (expired) await saveFollowUps(all);
			return;
		}
		const lastSend = getLastSendTime(all);
		if (now - lastSend < COOLDOWN_BETWEEN_SENDS_MS) {
			if (expired) await saveFollowUps(all);
			return;
		}

		// Find pending follow-ups ready to send
		const ready = all.filter(
			(fu) => fu.status === "pending" && fu.scheduledFor <= now,
		);

		// Process first ready follow-up
		const followUp = ready[0];
		if (!followUp) {
			if (expired) await saveFollowUps(all);
			return;
		}

		// Check if there's an active conversation (don't interrupt)
		const buffer = await loadSensory(followUp.chatId);
		if (now - buffer.lastActivity < ACTIVE_CONVERSATION_MS) {
			log.debug("[follow-ups] Active conversation detected, postponing");
			if (expired) await saveFollowUps(all);
			return;
		}

		// Check if user already mentioned the topic in recent messages
		const recentText = buffer.messages.map((m) => m.content).join(" ");
		if (
			computeTextScore(followUp.event, recentText) >= TOPIC_RESOLVED_THRESHOLD
		) {
			followUp.status = "cancelled";
			await saveFollowUps(all);
			log.debug(
				`[follow-ups] Cancelled (topic already discussed): "${followUp.event}"`,
			);
			return;
		}

		// Generate and send
		followUp.attempts++;
		expired = false; // any expirations get persisted by the saves below

		try {
			const message = await generateFollowUpMessage(followUp);

			if (!message.trim()) {
				log.debug("[follow-ups] Empty message generated, skipping");
				if (followUp.attempts >= MAX_ATTEMPTS) {
					followUp.status = "expired";
				}
				await saveFollowUps(all);
				return;
			}

			// Send the message (brief typing pulse first — receipt feedback and
			// a more human cadence for proactive messages)
			await pulseTypingBeforeSend(api, followUp.chatId);
			try {
				await api.sendMessage(followUp.chatId, message, {
					parse_mode: "Markdown",
				});
			} catch {
				await api.sendMessage(followUp.chatId, message);
			}

			followUp.status = "sent";
			followUp.sentAt = Date.now();
			log.debug(`[follow-ups] Sent follow-up for: "${followUp.event}"`);

			// Save bot message to sensory buffer for conversational continuity
			const botMessage: ConversationMessage = {
				role: "model",
				content: message,
				timestamp: Date.now(),
			};
			await withChatLock(followUp.chatId, async () => {
				const fresh = await loadSensory(followUp.chatId);
				const overflow = await addMessageToSensory(fresh, botMessage);
				if (overflow)
					trackBackground(
						"proactive-promotion",
						drainPromotionSpool(fresh.chatId),
					);
			});
		} catch (error) {
			log.error("[follow-ups] Error sending follow-up:", error);
			if (followUp.attempts >= MAX_ATTEMPTS) {
				followUp.status = "expired";
				log.debug(`[follow-ups] Max attempts reached for: "${followUp.event}"`);
			}
		}

		await saveFollowUps(all);
	});
}

// --- Detection hook (called from handlers) ---

export async function detectAndStoreFollowUps(
	chatId: number,
	recentMessages: string,
	latestMessage: string,
): Promise<void> {
	if (process.env.ENABLE_FOLLOW_UPS !== "true") return;

	const currentDateDR = formatDateTime();

	const extracted = await extractFollowUps(
		recentMessages,
		currentDateDR,
		latestMessage,
	);

	for (const fu of extracted) {
		const eventTime = new Date(fu.when).getTime();
		const scheduledFor = clampToReasonableHours(
			eventTime + fu.followUpDelayHours * 60 * 60 * 1000,
		);

		// Don't schedule in the past
		if (scheduledFor <= Date.now()) {
			log.debug(`[follow-ups] Skipping past follow-up: "${fu.event}"`);
			continue;
		}

		await addFollowUp({
			chatId,
			event: fu.event,
			followUpQuestion: fu.question,
			detectedAt: Date.now(),
			scheduledFor,
		});
	}
}

// --- Initialization ---

export async function initFollowUps(): Promise<void> {
	await saveFollowUps(await loadFollowUps());
}
