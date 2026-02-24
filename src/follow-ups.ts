import { readFile, writeFile } from "node:fs/promises";
import type { Api } from "grammy";
import { extractFollowUps, generateResponse } from "./ai.ts";
import {
	addMessageToSensory,
	computeTextScore,
	loadSensory,
} from "./memory.ts";
import type { ConversationMessage, FollowUp } from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const isDev = process.env.NODE_ENV === "development";
const FOLLOW_UPS_PATH = "./memory/follow-ups.json";

const MAX_PENDING = 5;
const MAX_SENDS_PER_DAY = 2;
const COOLDOWN_BETWEEN_SENDS_MS = 2 * 60 * 60 * 1000; // 2 hours
const EXPIRATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_ATTEMPTS = 3;
const ACTIVE_CONVERSATION_MS = 15 * 60 * 1000; // 15 minutes
const TOPIC_RESOLVED_THRESHOLD = 0.3;

// --- Storage ---

async function loadFollowUps(): Promise<FollowUp[]> {
	try {
		const data = await readFile(FOLLOW_UPS_PATH, "utf-8");
		return JSON.parse(data) as FollowUp[];
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[follow-ups] Error loading follow-ups.json:", err);
		}
		return [];
	}
}

async function saveFollowUps(followUps: FollowUp[]): Promise<void> {
	await atomicWriteFile(FOLLOW_UPS_PATH, JSON.stringify(followUps, null, 2));
}

export async function addFollowUp(
	followUp: Omit<FollowUp, "id" | "status" | "attempts">,
): Promise<boolean> {
	const all = await loadFollowUps();
	const pending = all.filter((fu) => fu.status === "pending");

	if (pending.length >= MAX_PENDING) {
		if (isDev)
			console.log("[follow-ups] Max pending reached, skipping new follow-up");
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

	if (isDev)
		console.log(
			`[follow-ups] Added: "${newFollowUp.event}" scheduled for ${new Date(newFollowUp.scheduledFor).toISOString()}`,
		);
	return true;
}

// --- Scheduling ---

function clampToReasonableHours(timestamp: number): number {
	// DR timezone offset: UTC-4
	const date = new Date(timestamp);
	const drTime = new Date(
		date.toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }),
	);
	const hour = drTime.getHours();
	const minute = drTime.getMinutes();

	// 8:00 AM - 9:30 PM is acceptable
	if (hour >= 8 && (hour < 21 || (hour === 21 && minute <= 30))) {
		return timestamp;
	}

	// Too late (after 9:30 PM) or too early (before 8 AM) → move to 9:00 AM next day
	const nextDay = new Date(drTime);
	if (hour >= 21 || hour < 8) {
		if (hour >= 21) {
			nextDay.setDate(nextDay.getDate() + 1);
		}
		nextDay.setHours(9, 0, 0, 0);
	}

	// Convert back: calculate offset from DR time to get UTC
	const originalDR = new Date(
		new Date(timestamp).toLocaleString("en-US", {
			timeZone: "America/Santo_Domingo",
		}),
	);
	const diffMs = timestamp - originalDR.getTime();
	return nextDay.getTime() + diffMs;
}

// --- Expiration ---

async function expireStaleFollowUps(): Promise<void> {
	const all = await loadFollowUps();
	const now = Date.now();
	let changed = false;

	for (const fu of all) {
		if (fu.status === "pending" && now - fu.scheduledFor > EXPIRATION_MS) {
			fu.status = "expired";
			changed = true;
			if (isDev) console.log(`[follow-ups] Expired: "${fu.event}"`);
		}
	}

	if (changed) await saveFollowUps(all);
}

// --- Rate Limiting ---

function getSendsToday(all: FollowUp[]): number {
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const todayMs = todayStart.getTime();

	return all.filter((fu) => fu.status === "sent" && fu.detectedAt > todayMs)
		.length;
}

function getLastSendTime(all: FollowUp[]): number {
	let lastSent = 0;
	for (const fu of all) {
		if (fu.status === "sent" && fu.detectedAt > lastSent) {
			// Use a rough "sent at" — scheduledFor is close enough
			lastSent = fu.scheduledFor;
		}
	}
	return lastSent;
}

// --- Cancellation ---

export async function checkAndCancelResolvedFollowUps(
	chatId: number,
	userContent: string,
): Promise<void> {
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
			if (isDev)
				console.log(
					`[follow-ups] Cancelled (user mentioned topic, score=${score.toFixed(2)}): "${fu.event}"`,
				);
		}
	}

	if (changed) await saveFollowUps(all);
}

// --- Follow-up message generation ---

async function generateFollowUpMessage(followUp: FollowUp): Promise<string> {
	const systemPrompt =
		"Eres una amiga casual. Genera una variación natural y breve de la pregunta dada. No expliques nada, solo responde con la pregunta variada.";
	const messages: ConversationMessage[] = [
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

	await expireStaleFollowUps();

	const all = await loadFollowUps();
	const now = Date.now();

	// Rate limits
	if (getSendsToday(all) >= MAX_SENDS_PER_DAY) return;
	const lastSend = getLastSendTime(all);
	if (now - lastSend < COOLDOWN_BETWEEN_SENDS_MS) return;

	// Find pending follow-ups ready to send
	const ready = all.filter(
		(fu) => fu.status === "pending" && fu.scheduledFor <= now,
	);

	if (ready.length === 0) return;

	// Process first ready follow-up
	const followUp = ready[0];

	// Check if there's an active conversation (don't interrupt)
	const buffer = await loadSensory(followUp.chatId);
	if (now - buffer.lastActivity < ACTIVE_CONVERSATION_MS) {
		if (isDev)
			console.log("[follow-ups] Active conversation detected, postponing");
		return;
	}

	// Check if user already mentioned the topic in recent messages
	const recentText = buffer.messages.map((m) => m.content).join(" ");
	if (
		computeTextScore(followUp.event, recentText) >= TOPIC_RESOLVED_THRESHOLD
	) {
		followUp.status = "cancelled";
		await saveFollowUps(all);
		if (isDev)
			console.log(
				`[follow-ups] Cancelled (topic already discussed): "${followUp.event}"`,
			);
		return;
	}

	// Generate and send
	followUp.attempts++;

	try {
		const message = await generateFollowUpMessage(followUp);

		if (!message.trim()) {
			if (isDev) console.log("[follow-ups] Empty message generated, skipping");
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
		if (isDev)
			console.log(`[follow-ups] Sent follow-up for: "${followUp.event}"`);

		// Save bot message to sensory buffer for conversational continuity
		const botMessage: ConversationMessage = {
			role: "model",
			content: message,
			timestamp: Date.now(),
		};
		await addMessageToSensory(buffer, botMessage);
	} catch (error) {
		console.error("[follow-ups] Error sending follow-up:", error);
		if (followUp.attempts >= MAX_ATTEMPTS) {
			followUp.status = "expired";
			if (isDev)
				console.log(
					`[follow-ups] Max attempts reached for: "${followUp.event}"`,
				);
		}
	}

	await saveFollowUps(all);
}

// --- Detection hook (called from handlers) ---

export async function detectAndStoreFollowUps(
	chatId: number,
	recentMessages: string,
	latestMessage: string,
): Promise<void> {
	if (process.env.ENABLE_FOLLOW_UPS !== "true") return;

	const now = new Date();
	const currentDateDR = now.toLocaleString("es-DO", {
		timeZone: "America/Santo_Domingo",
		dateStyle: "full",
		timeStyle: "short",
	});

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
			if (isDev)
				console.log(`[follow-ups] Skipping past follow-up: "${fu.event}"`);
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
			console.error("[follow-ups] Error reading follow-ups.json:", err);
		}
		await writeFile(FOLLOW_UPS_PATH, "[]");
		if (isDev) console.log("[follow-ups] Created follow-ups.json");
	}
}
