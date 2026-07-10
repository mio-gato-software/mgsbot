import { readFile, writeFile } from "node:fs/promises";
import type { Api } from "grammy";
import { generateResponse } from "./ai/core.ts";
import { extractFollowUps } from "./ai/evaluation.ts";
import { botNow, clampToReasonableHours, formatDateTime } from "./bot-time.ts";
import { log } from "./logger.ts";
import {
	addMessageToSensory,
	computeTextScore,
	loadSensory,
	withChatLock,
	withFollowUpsLock,
} from "./memory/index.ts";
import { unwrapVersioned, wrapVersioned } from "./memory/versioning.ts";
import type { ChatMessage } from "./providers/types.ts";
import type { ConversationMessage, FollowUp } from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

export const FOLLOW_UPS_PATH = "./memory/follow-ups.json";

const MAX_PENDING = 5;
const MAX_SENDS_PER_DAY = 2;
const COOLDOWN_BETWEEN_SENDS_MS = 2 * 60 * 60 * 1000; // 2 hours
const EXPIRATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_ATTEMPTS = 3;
export const ACTIVE_CONVERSATION_MS = 15 * 60 * 1000; // 15 minutes
const TOPIC_RESOLVED_THRESHOLD = 0.3;

// --- Storage ---

export async function loadFollowUps(): Promise<FollowUp[]> {
	try {
		const data = await readFile(FOLLOW_UPS_PATH, "utf-8");
		return unwrapVersioned<FollowUp[]>(JSON.parse(data));
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[follow-ups] Error loading follow-ups.json:", err);
		}
		return [];
	}
}

export async function saveFollowUps(followUps: FollowUp[]): Promise<void> {
	await atomicWriteFile(
		FOLLOW_UPS_PATH,
		JSON.stringify(wrapVersioned(followUps), null, 2),
	);
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

			// Send the message
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
				await addMessageToSensory(fresh, botMessage);
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
	try {
		await readFile(FOLLOW_UPS_PATH, "utf-8");
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[follow-ups] Error reading follow-ups.json:", err);
		}
		await writeFile(
			FOLLOW_UPS_PATH,
			JSON.stringify(wrapVersioned([]), null, 2),
		);
		log.debug("[follow-ups] Created follow-ups.json");
	}
}
