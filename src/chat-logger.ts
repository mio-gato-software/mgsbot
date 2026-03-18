import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { botNow } from "./bot-time.ts";
import { getBotName } from "./config.ts";

const LOGS_DIR = "./logs";
const enabled = process.env.ENABLE_CHAT_LOG === "true";

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
		console.error("[chat-logger] Error logging user message:", error);
	}
}

export async function logBotMessage(content: string): Promise<void> {
	if (!enabled) return;
	try {
		const ts = formatTimestamp();
		const botName = getBotName();
		await appendToLog(`[${botName} - ${ts}] ${content}\n\n`);
	} catch (error) {
		console.error("[chat-logger] Error logging bot message:", error);
	}
}
