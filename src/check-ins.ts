import { readdir, readFile } from "node:fs/promises";
import type { Api } from "grammy";
import { generateResponse } from "./ai.ts";
import { botNow, getBotHour, getBotMinute } from "./bot-time.ts";
import { generateEmbedding } from "./embeddings.ts";
import {
	addMessageToSensory,
	getFactsForSubjects,
	getPermanentFacts,
	getQueryEmbedding,
	getRelevantEpisodes,
	getRelevantFacts,
	loadSensory,
} from "./memory.ts";
import { buildMessages, buildSystemPrompt } from "./prompt.ts";
import type {
	CheckInSlot,
	CheckInState,
	ConversationMessage,
} from "./types.ts";
import { atomicWriteFile, isFileNotFound } from "./utils.ts";

const isDev = process.env.NODE_ENV === "development";

const CHECK_INS_PATH = "./memory/check-ins.json";
const SENSORY_DIR = "./memory/sensory";
const FOLLOW_UPS_PATH = "./memory/follow-ups.json";

const ACTIVE_CONVERSATION_MS = 15 * 60 * 1000; // 15 minutes
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
		return JSON.parse(data) as CheckInState[];
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[check-ins] Error loading check-ins.json:", err);
		}
		return [];
	}
}

async function saveCheckIns(states: CheckInState[]): Promise<void> {
	await atomicWriteFile(CHECK_INS_PATH, JSON.stringify(states, null, 2));
}

// --- Scheduling ---

function getWeekStart(date?: Date | number): string {
	const d = botNow(date);
	// Monday-based week: dayOfWeek 0=Sun, 1=Mon...6=Sat
	const dayOfWeek = d.day();
	const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	return d.subtract(daysFromMonday, "day").format("YYYY-MM-DD");
}

/**
 * Clamp a timestamp to reasonable hours (8:00 AM – 9:30 PM bot timezone).
 * If outside range, move to 9:00 AM next day.
 */
function clampToReasonableHours(timestamp: number): number {
	const hour = getBotHour(timestamp);
	const minute = getBotMinute(timestamp);

	if (hour >= 8 && (hour < 21 || (hour === 21 && minute <= 30))) {
		return timestamp;
	}

	let target = botNow(timestamp).hour(9).minute(0).second(0).millisecond(0);
	if (hour >= 21) {
		target = target.add(1, "day");
	}
	return target.valueOf();
}

/**
 * Generate random time slots for the week with weighted hour distribution.
 * Weighted toward morning (10-12) and evening (17-20) windows.
 */
function generateWeeklySlots(checkInsPerWeek: number): CheckInSlot[] {
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
			weightedHours[Math.floor(Math.random() * weightedHours.length)];
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
function pickDaysWithGap(
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
			console.error("[check-ins] Error reading sensory dir:", err);
		}
		return [];
	}
}

// --- Follow-up cross-check ---

async function followUpSentToday(): Promise<boolean> {
	try {
		const data = await readFile(FOLLOW_UPS_PATH, "utf-8");
		const followUps = JSON.parse(data) as Array<{
			status: string;
			scheduledFor: number;
		}>;
		const todayStart = botNow().startOf("day").valueOf();
		return followUps.some(
			(fu) => fu.status === "sent" && fu.scheduledFor >= todayStart,
		);
	} catch {
		return false;
	}
}

// --- Strategy Selection ---

function pickStrategy(recentStrategies: string[]): CheckInStrategy {
	// Filter out recently used strategies to avoid repetition
	const available = CHECK_IN_STRATEGIES.filter(
		(s) => !recentStrategies.slice(-3).includes(s),
	);
	const pool = available.length > 0 ? available : [...CHECK_IN_STRATEGIES];
	return pool[Math.floor(Math.random() * pool.length)];
}

function getStrategyInstruction(strategy: CheckInStrategy): string {
	switch (strategy) {
		case "random_thought":
			return "Se te acaba de ocurrir algo random — un pensamiento, una opinión, algo que viste o recordaste. Compártelo como si le estuvieras mandando un mensaje impulsivo a tu mejor amigo/a. NO hagas preguntas. Solo suelta el pensamiento. Ejemplos de tono: 'Diache, acabo de...', 'Loco/a no vas a creer...', 'Estoy aquí pensando en que...'.";
		case "memory_callback":
			return "Algo de tus recuerdos te vino a la mente — algo que te contó, algo que hicieron, un tema que compartieron. Menciónalo de manera casual como si te acabaras de acordar. Puede ser nostálgico, chistoso, o simplemente un 'me acordé de eso'. NO lo conviertas en una pregunta de seguimiento tipo PM.";
		case "sharing_moment":
			return "Comparte algo que estás 'haciendo' o 'viviendo' ahora mismo según la hora y tu personalidad. Cuéntalo como si compartieras un momento con alguien cercano — lo que estás viendo, escuchando, comiendo, sintiendo. NO preguntes nada. Solo comparte el momento.";
		case "reaction":
			return "Reacciona a algo — una idea, algo que 'viste', algo que te pasó, un pensamiento sobre algo del mundo. Exprésalo con emoción genuina (sorpresa, emoción, indignación divertida, etc). El tono debe ser como cuando le mandas un mensaje a alguien solo porque necesitas reaccionar con alguien.";
		case "weather_vibe":
			return "Usa el clima o el momento del día como base para compartir un VIBE, no un reporte meteorológico. Habla de cómo te hace sentir, qué ganas te da de hacer, o qué te recuerda. Hazlo personal y emocional, no informativo.";
		case "curiosity":
			return "Saca un tema que genuinamente te da curiosidad basándote en algo que sabes de la persona. NO lo formules como pregunta de entrevista ('¿Cómo va tu proyecto?'). En vez, comparte tu propia perspectiva o reacción primero y deja que la conversación fluya naturalmente.";
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
			"saludo casual conversación cotidiana cómo estás",
		);
	}

	// Gather context
	const [episodes, facts, permanentFacts] = await Promise.all([
		getRelevantEpisodes(chatId, queryEmbedding),
		getRelevantFacts(queryEmbedding),
		getPermanentFacts(),
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

	const systemPrompt = await buildSystemPrompt(
		episodes,
		allFacts,
		false,
		undefined,
		undefined,
		false,
		false,
		false,
		permanentFacts,
	);

	const strategyInstruction = getStrategyInstruction(strategy);
	const checkInBlock = `\n\n## Instrucción especial: Mensaje proactivo
Estás INICIANDO conversación. El usuario no te escribió — te nació escribirle porque eres así con la gente que te importa.

${strategyInstruction}

Cómo debe sonar tu mensaje:
- Como un mensaje de WhatsApp impulsivo, 1-3 oraciones máximo
- Prioriza COMPARTIR y COMENTAR por encima de PREGUNTAR — las amigas no siempre hacen preguntas, a veces solo sueltan lo que piensan
- Si haces una pregunta, que NO sea de seguimiento tipo "¿cómo vas con X?" — eso suena a project manager
- Usa tu personalidad REAL: humor, exageración, dramatismo, cariño, lo que sea que te salga natural
- Varía el estilo: no siempre empieces igual, no siempre uses el mismo tono
- NO uses marcadores especiales como [IMAGE:], [TTS], [SILENCE], o [REACT:]
- Si no tienes contexto suficiente, comparte un pensamiento random tuyo`;

	const messages = buildMessages(buffer);

	// Add a synthetic internal instruction as the last "user" message
	messages.push({
		role: "user",
		content:
			"[Sistema: Genera un mensaje proactivo para iniciar conversación. Responde SOLO con el mensaje que enviarías, sin explicaciones.]",
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
			if (isDev)
				console.log(
					`[check-ins] Created state for chat ${chatId} with ${state.slots.length} slots`,
				);
		}

		// New week? Regenerate slots
		if (state.weekStart !== currentWeekStart) {
			state.weekStart = currentWeekStart;
			state.slots = generateWeeklySlots(checkInsPerWeek);
			changed = true;
			if (isDev)
				console.log(
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
		if (await followUpSentToday()) {
			if (isDev)
				console.log("[check-ins] Follow-up sent today, skipping check-in");
			continue;
		}

		// Guard: active conversation
		const buffer = await loadSensory(chatId);
		if (now - buffer.lastActivity < ACTIVE_CONVERSATION_MS) {
			// Postpone by 1 hour
			pendingSlot.scheduledFor = clampToReasonableHours(now + POSTPONE_MS);
			changed = true;
			if (isDev)
				console.log("[check-ins] Active conversation, postponed check-in");
			continue;
		}

		// Pick strategy and generate message
		const strategy = pickStrategy(state.recentStrategies);

		try {
			const message = await generateCheckInMessage(chatId, strategy);

			if (!message.trim()) {
				if (isDev) console.log("[check-ins] Empty message generated, skipping");
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

			if (isDev)
				console.log(
					`[check-ins] Sent check-in (strategy=${strategy}) to chat ${chatId}`,
				);

			// Save bot message to sensory buffer for continuity
			const botMessage: ConversationMessage = {
				role: "model",
				content: message,
				timestamp: Date.now(),
			};
			await addMessageToSensory(buffer, botMessage);
		} catch (error) {
			console.error("[check-ins] Error sending check-in:", error);
			pendingSlot.status = "skipped";
			changed = true;
		}
	}

	if (changed) await saveCheckIns(states);
}

// --- Initialization ---

export async function initCheckIns(): Promise<void> {
	try {
		await readFile(CHECK_INS_PATH, "utf-8");
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error("[check-ins] Error reading check-ins.json:", err);
		}
		await atomicWriteFile(CHECK_INS_PATH, "[]");
		if (isDev) console.log("[check-ins] Created check-ins.json");
	}
}
