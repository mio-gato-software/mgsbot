import { readFile } from "node:fs/promises";
import type { ConversationMessage, SensoryBuffer } from "../types.ts";
import { atomicWriteFile, isFileNotFound } from "../utils.ts";

export const SENSORY_DIR = "./memory/sensory";

const SENSORY_MAX_MESSAGES = 10;
const SENSORY_OVERFLOW_COUNT = 5; // Messages returned on overflow
const INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MEDIA_MESSAGE_COMPACT_TARGET_CHARS = 240;
const UNCOMPRESSED_RECENT_MESSAGES = 2;
const MEDIA_MESSAGE_PATTERNS = [
	{
		regex: /^(\[Audio[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous transcription compacted",
	},
	{
		regex: /^(\[Image[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous visual description compacted",
	},
	{
		regex: /^(\[YouTube video[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous summary compacted",
	},
] as const;

function normalizeForCompactPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function compactMediaMessageContent(content: string): string {
	for (const pattern of MEDIA_MESSAGE_PATTERNS) {
		const match = content.match(pattern.regex);
		if (!match) continue;

		const prefix = match[1] ?? content;
		const body = normalizeForCompactPreview(match[2] ?? "");
		if (!body) return prefix;
		if (body.startsWith(`[${pattern.label}]`)) {
			return `${prefix} ${body}`;
		}
		if (body.length <= MEDIA_MESSAGE_COMPACT_TARGET_CHARS) {
			return `${prefix} ${body}`;
		}

		const truncated = body
			.slice(0, MEDIA_MESSAGE_COMPACT_TARGET_CHARS)
			.trimEnd();
		return `${prefix} [${pattern.label}] ${truncated}...`;
	}

	return content;
}

function compactOlderMediaMessages(messages: ConversationMessage[]): void {
	const compactUntil = Math.max(
		0,
		messages.length - UNCOMPRESSED_RECENT_MESSAGES,
	);
	for (let i = 0; i < compactUntil; i++) {
		const message = messages[i];
		if (!message) continue;
		messages[i] = {
			...message,
			content: compactMediaMessageContent(message.content),
		};
	}
}

function sensoryPath(chatId: number): string {
	return `${SENSORY_DIR}/${chatId}.json`;
}

export async function loadSensory(chatId: number): Promise<SensoryBuffer> {
	try {
		const data = await readFile(sensoryPath(chatId), "utf-8");
		const buffer = JSON.parse(data) as SensoryBuffer;

		// Clear messages if inactive for > 3 days
		if (Date.now() - buffer.lastActivity > INACTIVITY_THRESHOLD_MS) {
			buffer.messages = [];
		}

		return buffer;
	} catch (err) {
		if (!isFileNotFound(err)) {
			console.error(`[memory] Error loading sensory buffer ${chatId}:`, err);
		}
		return {
			chatId,
			messages: [],
			lastActivity: Date.now(),
			messageCountSincePromotion: 0,
		};
	}
}

export async function saveSensory(buffer: SensoryBuffer): Promise<void> {
	buffer.lastActivity = Date.now();
	await atomicWriteFile(
		sensoryPath(buffer.chatId),
		JSON.stringify(buffer, null, 2),
	);
}

/**
 * Add a message to the sensory buffer.
 * Returns overflow messages (oldest 5) if buffer exceeds 10, otherwise null.
 */
export async function addMessageToSensory(
	buffer: SensoryBuffer,
	message: ConversationMessage,
): Promise<ConversationMessage[] | null> {
	buffer.messages.push(message);
	buffer.messageCountSincePromotion++;

	let overflow: ConversationMessage[] | null = null;

	if (buffer.messages.length > SENSORY_MAX_MESSAGES) {
		overflow = buffer.messages.slice(0, SENSORY_OVERFLOW_COUNT);
		buffer.messages = buffer.messages.slice(SENSORY_OVERFLOW_COUNT);
	}

	compactOlderMediaMessages(buffer.messages);
	await saveSensory(buffer);
	return overflow;
}
