import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { botNow } from "./bot-time.ts";
import { getBotName } from "./config.ts";
import { log } from "./logger.ts";

const LOGS_DIR = "./logs";
const enabled = process.env.ENABLE_CHAT_LOG === "true";

const DEFAULT_RETENTION_DAYS = 30;
const retentionDays = (() => {
	const raw = Number(process.env.CHAT_LOG_RETENTION_DAYS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
})();

// Date string of the last write; retention only runs when it changes.
let lastLoggedDate: string | null = null;

async function pruneOldLogs(today: string): Promise<void> {
	try {
		const cutoff = botNow().subtract(retentionDays, "day").format("YYYY-MM-DD");
		const files = await readdir(LOGS_DIR);
		for (const file of files) {
			const match = file.match(/^(\d{4}-\d{2}-\d{2})\.txt$/);
			if (match?.[1] && match[1] < cutoff && match[1] !== today) {
				await unlink(`${LOGS_DIR}/${file}`).catch(() => {});
			}
		}
	} catch (error) {
		log.error("[chat-logger] Error pruning old logs:", error);
	}
}

function formatTimestamp(date?: Date | number): string {
	const d = botNow(date);
	return d.format("YYYY-MM-DD HH:mm:ss");
}

function getDailyFilePath(): string {
	const d = botNow();
	return `${LOGS_DIR}/${d.format("YYYY-MM-DD")}.txt`;
}

async function ensureDir(): Promise<void> {
	if (!existsSync(LOGS_DIR)) {
		await mkdir(LOGS_DIR, { recursive: true });
	}
}

async function appendToLog(line: string): Promise<void> {
	await ensureDir();
	const today = botNow().format("YYYY-MM-DD");
	if (today !== lastLoggedDate) {
		lastLoggedDate = today;
		await pruneOldLogs(today);
	}
	await appendFile(getDailyFilePath(), line, "utf-8");
}

export async function logUserMessage(
	userName: string,
	content: string,
): Promise<void> {
	if (!enabled) return;
	try {
		const ts = formatTimestamp();
		await appendToLog(`[${userName} - ${ts}] ${content}\n`);
	} catch (error) {
		log.error("[chat-logger] Error logging user message:", error);
	}
}

export async function logBotMessage(content: string): Promise<void> {
	if (!enabled) return;
	try {
		const ts = formatTimestamp();
		const botName = getBotName();
		await appendToLog(`[${botName} - ${ts}] ${content}\n\n`);
	} catch (error) {
		log.error("[chat-logger] Error logging bot message:", error);
	}
}
