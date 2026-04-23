import type { ChatMessage, MediaAttachment } from "./providers/types.ts";
import type { ConversationMessage, SensoryBuffer } from "./types.ts";

function formatTimeGap(diffMs: number): string {
	const diffHours = diffMs / (1000 * 60 * 60);
	const diffDays = diffMs / (1000 * 60 * 60 * 24);

	if (diffHours < 2) return `~${Math.round(diffHours)} hour passed`;
	if (diffHours < 24) return `~${Math.round(diffHours)} hours passed`;
	if (diffDays < 2) return "~1 day passed";
	return `~${Math.round(diffDays)} days passed`;
}

const TIME_GAP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const PROMPT_HISTORY_MAX_MESSAGES = 6;
const PROMPT_HISTORY_MAX_CHARS = 2200;
const PROMPT_HISTORY_ALWAYS_KEEP_FULL = 2;
const PROMPT_HISTORY_TRUNCATE_CHARS = 450;

function formatConversationMessage(
	msg: ConversationMessage,
	preserveFull = false,
): ChatMessage {
	const role = msg.role === "user" ? "user" : "assistant";
	const rawContent =
		msg.role === "user" && msg.name
			? `[${msg.name}]: ${msg.content}`
			: msg.content;
	const content =
		preserveFull || rawContent.length <= PROMPT_HISTORY_TRUNCATE_CHARS
			? rawContent
			: `${rawContent.slice(0, PROMPT_HISTORY_TRUNCATE_CHARS).trimEnd()}... [previous message truncated]`;

	return { role, content };
}

export function buildMessages(
	buffer: SensoryBuffer,
	mediaAttachment?: MediaAttachment,
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const selected: Array<{
		formatted: ChatMessage;
		original: ConversationMessage;
	}> = [];
	let totalChars = 0;

	for (let i = buffer.messages.length - 1; i >= 0; i--) {
		const original = buffer.messages[i];
		const preserveFull =
			buffer.messages.length - i <= PROMPT_HISTORY_ALWAYS_KEEP_FULL;
		const formatted = formatConversationMessage(original, preserveFull);
		const isRequired = selected.length < PROMPT_HISTORY_ALWAYS_KEEP_FULL;
		const fitsBudget =
			selected.length < PROMPT_HISTORY_MAX_MESSAGES &&
			totalChars + formatted.content.length <= PROMPT_HISTORY_MAX_CHARS;

		if (!isRequired && !fitsBudget) {
			break;
		}

		selected.push({ formatted, original });
		totalChars += formatted.content.length;
	}

	selected.reverse();

	for (let i = 0; i < selected.length; i++) {
		const entry = selected[i];
		const msg = entry.original;

		// Insert time gap marker when significant time has passed between messages
		if (i > 0) {
			const prevMsg = selected[i - 1].original;
			const gap = msg.timestamp - prevMsg.timestamp;
			if (gap >= TIME_GAP_THRESHOLD_MS) {
				messages.push({
					role: "user",
					content: `[${formatTimeGap(gap)} with no chat activity]`,
				});
			}
		}

		messages.push(entry.formatted);
	}

	// Attach media to the last user message (transient, not persisted)
	if (mediaAttachment && messages.length > 0) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				messages[i] = { ...messages[i], mediaAttachment };
				break;
			}
		}
	}

	return messages;
}
