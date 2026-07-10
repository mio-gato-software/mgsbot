import { readdir, readFile } from "node:fs/promises";
import type { Api } from "grammy";
import { generateResponse } from "./ai/core.ts";
import { botNow, clampToReasonableHours, getWeekStart } from "./bot-time.ts";
import { generateEmbedding } from "./embeddings.ts";
import { ACTIVE_CONVERSATION_MS, wasFollowUpSentToday } from "./follow-ups.ts";
import { log } from "./logger.ts";
import {
	addMessageToSensory,
	getFactsForSubjects,
	getPermanentFacts,
	getQueryEmbedding,
	getRecentChapters,
	getRelevantEpisodes,
	getRelevantFacts,
	loadRelationshipMemory,
	loadSensory,
	withChatLock,
	withCheckInsLock,
} from "./memory/index.ts";
import { unwrapVersioned, wrapVersioned } from "./memory/versioning.ts";
import { assembleSystemPrompt } from "./prompt/assemble.ts";
import { buildPromptContext } from "./prompt/context.ts";
import { buildMessages } from "./prompt/history.ts";
import type {
	CheckInSlot,
	CheckInState,
	ConversationMessage,
} from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const CHECK_INS_PATH = "./memory/check-ins.json";
const SENSORY_DIR = "./memory/sensory";

const POSTPONE_MS = 60 * 60 * 1000; // 1 hour

const CHECK_IN_STRATEGIES = [
	"random_thought",
	"memory_callback",
	"sharing_moment",
	"reaction",
	"weather_vibe",
	"curiosity",
] as const;

type CheckInStrategy = (typeof CHECK_IN_STRATEGIES)[number];

// --- Storage ---

async function loadCheckIns(): Promise<CheckInState[]> {
	try {
		const data = await readFile(CHECK_INS_PATH, "utf-8");
		return unwrapVersioned<CheckInState[]>(JSON.parse(data));
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[check-ins] Error loading check-ins.json:", err);
		}
		return [];
	}
}

async function saveCheckIns(states: CheckInState[]): Promise<void> {
	await atomicWriteFile(
		CHECK_INS_PATH,
		JSON.stringify(wrapVersioned(states), null, 2),
	);
}

// --- Scheduling ---

export { clampToReasonableHours, getWeekStart } from "./bot-time.ts";

/**
 * Generate random time slots for the week with weighted hour distribution.
 * Weighted toward morning (10-12) and evening (17-20) windows.
 */
export function generateWeeklySlots(checkInsPerWeek: number): CheckInSlot[] {
	const now = Date.now();
	const monday = botNow()
		.startOf("day")
		.subtract(botNow().day() === 0 ? 6 : botNow().day() - 1, "day");

	// Available days: 0=Mon through 6=Sun
	const availableDays: number[] = [];
	for (let d = 0; d < 7; d++) {
		const dayTs = monday.add(d, "day").valueOf();
		// Only include future days (or today if early enough)
		if (dayTs + 21 * 60 * 60 * 1000 > now) {
			availableDays.push(d);
		}
	}

	if (availableDays.length === 0) return [];

	// Pick N random days with minimum 2-day gap
	const selectedDays = pickDaysWithGap(
		availableDays,
		Math.min(checkInsPerWeek, availableDays.length),
		2,
	);

	// Weighted hours: prefer 10-12 and 17-20
	const weightedHours = [
		8, 9, 10, 10, 10, 11, 11, 11, 12, 12, 13, 14, 15, 16, 17, 17, 17, 18, 18,
		18, 19, 19, 19, 20, 20,
	];

	const slots: CheckInSlot[] = [];
	for (const dayOffset of selectedDays) {
		const hour =
			weightedHours[Math.floor(Math.random() * weightedHours.length)] ?? 10;
		const minute = Math.floor(Math.random() * 60);
		const slotTime = monday
			.add(dayOffset, "day")
			.hour(hour)
			.minute(minute)
			.second(0)
			.millisecond(0);

		const clamped = clampToReasonableHours(slotTime.valueOf());

		// Only add if in the future
		if (clamped > now) {
			slots.push({ scheduledFor: clamped, status: "pending" });
		}
	}

	return slots;
}

/**
 * Pick N days from available days with a minimum gap between them.
 */
export function pickDaysWithGap(
	available: number[],
	count: number,
	minGap: number,
): number[] {
	if (count <= 0 || available.length === 0) return [];

	// Shuffle available days
	const shuffled = [...available].sort(() => Math.random() - 0.5);
	const selected: number[] = [];

	for (const day of shuffled) {
		if (selected.length >= count) break;
		const tooClose = selected.some((s) => Math.abs(s - day) < minGap);
		if (!tooClose) {
			selected.push(day);
		}
	}

	// If we couldn't fill all slots with the gap constraint, relax and pick remaining
	if (selected.length < count) {
		for (const day of shuffled) {
			if (selected.length >= count) break;
			if (!selected.includes(day)) {
				selected.push(day);
			}
		}
	}

	return selected.sort((a, b) => a - b);
}

// --- Chat Discovery ---

async function getEligibleChatIds(): Promise<number[]> {
	const ownerUserId = process.env.OWNER_USER_ID;
	if (!ownerUserId) return [];

	try {
		const files = await readdir(SENSORY_DIR);
		const chatIds: number[] = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const id = Number.parseInt(file.replace(".json", ""), 10);
			// Only DM chats (chatId == userId for DMs in Telegram)
			if (!Number.isNaN(id) && String(id) === ownerUserId) {
				chatIds.push(id);
			}
		}
		return chatIds;
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[check-ins] Error reading sensory dir:", err);
		}
		return [];
	}
}

// --- Strategy Selection ---

function pickStrategy(recentStrategies: string[]): CheckInStrategy {
	// Filter out recently used strategies to avoid repetition
	const available = CHECK_IN_STRATEGIES.filter(
		(s) => !recentStrategies.slice(-3).includes(s),
	);
	const pool = available.length > 0 ? available : [...CHECK_IN_STRATEGIES];
	return pool[Math.floor(Math.random() * pool.length)] ?? "random_thought";
}

function getStrategyInstruction(strategy: CheckInStrategy): string {
	switch (strategy) {
		case "random_thought":
			return "A random thought just hit you — an idea, an opinion, something you saw or remembered. Share it as if you were sending an impulsive message to your best friend. Do NOT ask questions. Just drop the thought.";
		case "memory_callback":
			return "Something from your memories came to mind — something they told you, something you did together, a topic you shared. Mention it casually, as if you just remembered it. It can be nostalgic, funny, or just a 'that reminded me of...'. Do NOT turn it into a project-manager-style follow-up question.";
		case "sharing_moment":
			return "Share something you're 'doing' or 'living' right now based on the time of day and your personality. Tell it as if you were sharing a moment with someone close — what you're seeing, hearing, eating, feeling. Do NOT ask anything. Just share the moment.";
		case "reaction":
			return "React to something — an idea, something you 'saw', something that happened to you, a thought about something in the world. Express it with genuine emotion (surprise, excitement, amused outrage, etc.). The tone should be like when you message someone just because you need to react with somebody.";
		case "weather_vibe":
			return "Use the weather or the time of day as a base to share a VIBE, not a weather report. Talk about how it makes you feel, what it makes you want to do, or what it reminds you of. Make it personal and emotional, not informative.";
		case "curiosity":
			return "Bring up a topic that genuinely makes you curious based on something you know about the person. Do NOT phrase it as an interview question ('How's your project going?'). Instead, share your own perspective or reaction first and let the conversation flow naturally.";
	}
}

// --- Message Generation ---

async function generateCheckInMessage(
	chatId: number,
	strategy: CheckInStrategy,
): Promise<string> {
	const buffer = await loadSensory(chatId);

	// Build query embedding from recent messages or generic greeting
	let queryEmbedding: number[];
	if (buffer.messages.length > 0) {
		const result = await getQueryEmbedding(buffer.messages);
		queryEmbedding = result.embedding;
	} else {
		queryEmbedding = await generateEmbedding(
			"casual greeting everyday conversation how are you",
		);
	}

	// Gather context
	const [episodes, facts, permanentFacts, relationshipMemory, recentChapters] =
		await Promise.all([
			getRelevantEpisodes(chatId, queryEmbedding),
			getRelevantFacts(queryEmbedding, { chatId }),
			getPermanentFacts(),
			loadRelationshipMemory(chatId),
			getRecentChapters(chatId),
		]);

	// Get person-specific facts from recent conversation participants
	const participantNames = new Set<string>();
	for (const msg of buffer.messages) {
		if (msg.name) participantNames.add(msg.name);
	}
	const subjectFacts =
		participantNames.size > 0
			? await getFactsForSubjects([...participantNames])
			: [];

	// Combine and deduplicate facts
	const allFacts = [...facts];
	for (const sf of subjectFacts) {
		if (!allFacts.some((f) => f.id === sf.id)) {
			allFacts.push(sf);
		}
	}

	const systemPrompt = await assembleSystemPrompt(
		buildPromptContext({
			relevantEpisodes: episodes,
			relevantFacts: allFacts,
			permanentFacts,
			relationshipMemory,
			recentChapters,
		}),
	);

	const strategyInstruction = getStrategyInstruction(strategy);
	const checkInBlock = `\n\n## Special instruction: Proactive message
You are STARTING the conversation. The user didn't write to you — it just occurred to you to message them because that's how you are with people you care about.

${strategyInstruction}

How your message should sound:
- Like an impulsive WhatsApp message, 1-3 sentences max
- Prioritize SHARING and COMMENTING over ASKING — friends don't always ask questions, sometimes they just drop what they're thinking
- If you ask a question, it should NOT be a follow-up type ("how's X going?") — that sounds like a project manager
- Use your REAL personality: humor, exaggeration, drama, warmth, whatever comes natural
- Vary the style: don't always start the same way, don't always use the same tone
- Do NOT use special markers like [IMAGE:], [TTS], [SILENCE], or [REACT:]
- Write in the user's language (match the language they used in past messages)
- If you don't have enough context, share a random thought of yours`;

	const messages = buildMessages(buffer);

	// Add a synthetic internal instruction as the last "user" message
	messages.push({
		role: "user",
		content:
			"[System: Generate a proactive message to start a conversation. Respond ONLY with the message you would send, no explanations.]",
	});

	return generateResponse(systemPrompt + checkInBlock, messages);
}

// --- Main Loop ---

export async function checkAndSendCheckIns(
	api: Api,
	isBotOff: () => boolean,
	isSleepingHour: () => boolean,
): Promise<void> {
	if (process.env.ENABLE_CHECK_INS !== "true") return;
	if (isBotOff()) return;
	if (isSleepingHour()) return;

	const chatIds = await getEligibleChatIds();
	if (chatIds.length === 0) return;

	const checkInsPerWeek = Math.max(
		1,
		Number.parseInt(process.env.CHECK_INS_PER_WEEK ?? "2", 10) || 2,
	);

	// Hold the check-ins lock for the whole cycle so overlapping ticks (or any
	// future writer) can't clobber slot status changes with a stale array.
	await withCheckInsLock(async () => {
		const states = await loadCheckIns();
		const currentWeekStart = getWeekStart();
		let changed = false;

		for (const chatId of chatIds) {
			let state = states.find((s) => s.chatId === chatId);

			// Create state if missing
			if (!state) {
				state = {
					chatId,
					weekStart: currentWeekStart,
					slots: generateWeeklySlots(checkInsPerWeek),
					lastSentTimestamp: 0,
					recentStrategies: [],
				};
				states.push(state);
				changed = true;
				log.debug(
					`[check-ins] Created state for chat ${chatId} with ${state.slots.length} slots`,
				);
			}

			// New week? Regenerate slots
			if (state.weekStart !== currentWeekStart) {
				state.weekStart = currentWeekStart;
				state.slots = generateWeeklySlots(checkInsPerWeek);
				changed = true;
				log.debug(
					`[check-ins] New week for chat ${chatId}, generated ${state.slots.length} slots`,
				);
			}

			// Find the next pending slot that's due
			const now = Date.now();
			const pendingSlot = state.slots.find(
				(s) => s.status === "pending" && s.scheduledFor <= now,
			);
			if (!pendingSlot) continue;

			// Guard: follow-up already sent today
			if (await wasFollowUpSentToday()) {
				log.debug("[check-ins] Follow-up sent today, skipping check-in");
				continue;
			}

			// Guard: active conversation
			const buffer = await loadSensory(chatId);
			if (now - buffer.lastActivity < ACTIVE_CONVERSATION_MS) {
				// Postpone by 1 hour
				pendingSlot.scheduledFor = clampToReasonableHours(now + POSTPONE_MS);
				changed = true;
				log.debug("[check-ins] Active conversation, postponed check-in");
				continue;
			}

			// Pick strategy and generate message
			const strategy = pickStrategy(state.recentStrategies);

			try {
				const message = await generateCheckInMessage(chatId, strategy);

				if (!message.trim()) {
					log.debug("[check-ins] Empty message generated, skipping");
					pendingSlot.status = "skipped";
					changed = true;
					continue;
				}

				// Send the message
				try {
					await api.sendMessage(chatId, message, { parse_mode: "Markdown" });
				} catch {
					await api.sendMessage(chatId, message);
				}

				pendingSlot.status = "sent";
				state.lastSentTimestamp = now;
				state.recentStrategies.push(strategy);
				if (state.recentStrategies.length > 5) {
					state.recentStrategies = state.recentStrategies.slice(-5);
				}
				changed = true;

				log.debug(
					`[check-ins] Sent check-in (strategy=${strategy}) to chat ${chatId}`,
				);

				// Save bot message to sensory buffer for continuity
				const botMessage: ConversationMessage = {
					role: "model",
					content: message,
					timestamp: Date.now(),
				};
				await withChatLock(chatId, async () => {
					const fresh = await loadSensory(chatId);
					await addMessageToSensory(fresh, botMessage);
				});
			} catch (error) {
				log.error("[check-ins] Error sending check-in:", error);
				pendingSlot.status = "skipped";
				changed = true;
			}
		}

		if (changed) await saveCheckIns(states);
	});
}

// --- Initialization ---

export async function initCheckIns(): Promise<void> {
	try {
		await readFile(CHECK_INS_PATH, "utf-8");
	} catch (err) {
		if (!isFileNotFound(err)) {
			log.error("[check-ins] Error reading check-ins.json:", err);
		}
		await atomicWriteFile(
			CHECK_INS_PATH,
			JSON.stringify(wrapVersioned([]), null, 2),
		);
		log.debug("[check-ins] Created check-ins.json");
	}
}
