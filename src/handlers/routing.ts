// Shared routing helpers for the message handlers: mention detection,
// reply-context builders, passive group voice gating, and the group
// name-mention router. Used by the core text handler plus the voice and
// photo handler modules.
import type { Context } from "grammy";
import {
	classifyEditIntent,
	classifyGroupSocialIntent,
} from "../ai/classifiers.ts";
import { isBotOff, isSleepingHour } from "../bot-state.ts";
import { getBotName } from "../config.ts";
import {
	isGroupChat,
	observeConversationTurn,
	processConversation,
} from "../conversation.ts";
import { openGroupContinuationWindow } from "../group-state.ts";
import { loadSensory } from "../memory/index.ts";
import type { ConversationMessage, MentionType } from "../types.ts";

const groupVoiceContextEnabled =
	process.env.ENABLE_GROUP_VOICE_CONTEXT !== "false";
const GROUP_PASSIVE_VOICE_MAX_SECONDS = readNonNegativeEnvNumber(
	"GROUP_PASSIVE_VOICE_MAX_SECONDS",
	120,
);
const GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS = readNonNegativeEnvNumber(
	"GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS",
	1200,
);

export interface TelegramReplyContext {
	senderName: string;
	content: string;
	isBot: boolean;
}

interface ClassifierReplyContext {
	speaker: string;
	message: string;
	isBot: boolean;
}

export function buildGroupResponseOptions(input: {
	groupAutoReply: boolean;
	groupContinuation: boolean;
}) {
	return {
		skipHistoricalContext: input.groupAutoReply && !input.groupContinuation,
		userTurnAlreadyRecorded: true,
		groupAutoReply: input.groupAutoReply,
		groupContinuation: input.groupContinuation,
	};
}

/**
 * Regex fallback for edit intent detection when the LLM classifier is unavailable.
 */
const EDIT_INTENT_REGEX =
	/\b(edit|change|modify|add|remove|make it|turn it|turn this|transform|replace|paint|convert|crop|resize|edita|edítala|edítalo|cambia|cámbiale|modifica|modifícala|modifícalo|ponle|pónle|agrégale|agregale|añádele|añadele|quítale|quitale|hazla|hazlo|haz que|conviértela|conviertela|conviértelo|conviertelo|transforma|pinta|píntala|pintalo|reemplaza|sustituye)\b/i;

// Strips brackets from user-supplied text before interpolation into
// bracketed context strings like "[Image from ...]" so users can't
// inject fake markers.
export function sanitizeBracketText(text: string): string {
	return text.replace(/[[\]]/g, "");
}

function readNonNegativeEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getTelegramUserName(user?: {
	first_name?: string;
	last_name?: string;
	username?: string;
}): string {
	if (!user) return "Unknown";
	if (user.first_name && user.last_name) {
		return `${user.first_name} ${user.last_name}`;
	}
	return user.first_name ?? user.username ?? "Unknown";
}

function getReplyMessageContent(ctx: Context): string | undefined {
	const replyMsg = ctx.message?.reply_to_message;
	if (!replyMsg) return undefined;
	if (replyMsg.text?.trim()) return replyMsg.text.trim();
	if (replyMsg.caption?.trim()) return replyMsg.caption.trim();
	if (replyMsg.photo?.length) return "[photo]";
	if (replyMsg.voice) return "[voice message]";
	if (replyMsg.audio) return "[audio file]";
	if (replyMsg.document) {
		return replyMsg.document.file_name
			? `[document: ${replyMsg.document.file_name}]`
			: "[document]";
	}
	return "[message]";
}

const REPLY_CONTEXT_MAX_CHARS = 500;

function truncateReplyContext(text: string): string {
	if (text.length <= REPLY_CONTEXT_MAX_CHARS) return text;
	return `${text.slice(0, REPLY_CONTEXT_MAX_CHARS - 12).trimEnd()} [truncated]`;
}

export function getTelegramReplyContext(
	ctx: Context,
	botId: number,
): TelegramReplyContext | undefined {
	const replyMsg = ctx.message?.reply_to_message;
	if (!replyMsg) return undefined;
	const content = getReplyMessageContent(ctx);
	if (!content) return undefined;
	return {
		senderName: getTelegramUserName(replyMsg.from),
		content,
		isBot: replyMsg.from?.id === botId,
	};
}

export function toClassifierReplyContext(
	replyContext?: TelegramReplyContext,
): ClassifierReplyContext | undefined {
	if (!replyContext) return undefined;
	return {
		speaker: replyContext.senderName,
		message: replyContext.content,
		isBot: replyContext.isBot,
	};
}

export function buildReplyAwareTextContent(
	text: string,
	replyContext?: TelegramReplyContext,
): string {
	if (!replyContext) return text;
	const botMarker = replyContext.isBot ? " (bot)" : "";
	return `[Replying to ${replyContext.senderName}${botMarker}: "${truncateReplyContext(replyContext.content)}"]\n\n${text}`;
}

/**
 * Does the caption express intent to edit/modify the image?
 * When true, we can skip describeImage since the model will likely emit
 * [IMAGE: ...] and the edit provider uses the raw image directly.
 *
 * Uses an LLM classifier for nuance; falls back to a regex if the classifier
 * fails or is inconclusive.
 */
export async function hasEditIntent(caption?: string): Promise<boolean> {
	if (!caption) return false;
	const classification = await classifyEditIntent(caption);
	if (classification !== null) return classification;
	return EDIT_INTENT_REGEX.test(caption);
}

function normalizeForLooseMatch(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
}

function textMentionsBotName(text: string): boolean {
	const botName = normalizeForLooseMatch(getBotName());
	if (!botName.trim()) return false;
	const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const nameRegex = new RegExp(`\\b${escaped}\\b`, "i");
	return nameRegex.test(normalizeForLooseMatch(text));
}

export function detectMentionType(ctx: Context, botId: number): MentionType {
	// Check if replied to the bot - always respond
	if (ctx.message?.reply_to_message?.from?.id === botId) return "reply";

	const text = ctx.message?.text ?? ctx.message?.caption ?? "";
	const entities =
		ctx.message?.text !== undefined
			? (ctx.message.entities ?? [])
			: (ctx.message?.caption_entities ?? []);

	// Check if @mentioned - always respond
	for (const entity of entities) {
		if (entity.type === "mention") {
			const mention = text.slice(entity.offset, entity.offset + entity.length);
			if (mention === `@${ctx.me?.username}`) return "tag";
		}
	}

	// Check if called by name - AI decides if addressed or just mentioned
	if (textMentionsBotName(text)) return "name";

	return "none";
}

export function detectTranscribedMentionType(
	ctx: Context,
	botId: number,
	transcription: string,
): MentionType {
	if (ctx.message?.reply_to_message?.from?.id === botId) return "reply";
	if (textMentionsBotName(transcription)) return "name";
	return "none";
}

export function isIgnorableGroupMessage(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) {
		return true;
	}
	return false;
}

export function getLastBotMessageBeforeLatest(
	messages: ConversationMessage[],
): string | undefined {
	for (let i = messages.length - 2; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "model") return message.content;
	}
	return undefined;
}

export function isUsableTranscription(transcription: string): boolean {
	const trimmed = transcription.trim();
	return !!trimmed && trimmed !== "[transcription failed]";
}

export function shouldTranscribePassiveGroupVoice(duration?: number): boolean {
	if (!groupVoiceContextEnabled) return false;
	if (GROUP_PASSIVE_VOICE_MAX_SECONDS <= 0) return false;
	return duration === undefined || duration <= GROUP_PASSIVE_VOICE_MAX_SECONDS;
}

function formatVoiceDuration(duration?: number): string {
	if (duration === undefined) return "";
	return `, ${duration}s`;
}

function truncateForPassiveVoiceContext(text: string): string {
	if (text.length <= GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS) return text;
	return `${text
		.slice(0, GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS)
		.trimEnd()} [truncated]`;
}

export function buildVoiceContent(
	userName: string,
	transcription: string,
): string {
	return `[Audio from ${userName}]: ${transcription}`;
}

export function buildPassiveVoiceContent(
	userName: string,
	transcription: string,
): string {
	return `[Voice message from ${userName}]: ${truncateForPassiveVoiceContext(transcription)}`;
}

export function buildUntranscribedVoiceContent(
	userName: string,
	duration?: number,
): string {
	if (!groupVoiceContextEnabled) {
		return `[Voice message from ${userName}${formatVoiceDuration(duration)}, not transcribed because group voice context is disabled]`;
	}
	return `[Voice message from ${userName}${formatVoiceDuration(duration)}, not transcribed because it exceeds the passive group limit of ${GROUP_PASSIVE_VOICE_MAX_SECONDS}s]`;
}

export async function processConversationAndTrackGroupContinuation(
	...args: Parameters<typeof processConversation>
): Promise<boolean> {
	const [ctx] = args;
	const didRespond = await processConversation(...args);
	const chatId = ctx.chat?.id;
	if (didRespond && chatId && isGroupChat(ctx)) {
		openGroupContinuationWindow(chatId);
	}
	return didRespond;
}

export async function routeGroupNameMention(
	ctx: Context,
	text: string,
	userName: string,
	options?: {
		conversationContent?: string;
		isVoiceMessage?: boolean;
	},
): Promise<"full" | "handled"> {
	const chatId = ctx.chat?.id;
	if (!chatId) return "handled";
	const replyContext = getTelegramReplyContext(ctx, ctx.me.id);
	const conversationContent = buildReplyAwareTextContent(
		options?.conversationContent ?? text,
		replyContext,
	);

	const buffer = await loadSensory(chatId);
	const currentTurn: ConversationMessage = {
		role: "user",
		name: userName,
		content: conversationContent,
		timestamp: Date.now(),
	};
	const recentMessages = [...buffer.messages, currentTurn];
	const lastBotMessage = getLastBotMessageBeforeLatest(recentMessages);
	const decision = await classifyGroupSocialIntent({
		mode: "name",
		botName: getBotName(),
		currentSpeaker: userName,
		currentMessage: text,
		recentMessages,
		lastBotMessage,
		replyContext: toClassifierReplyContext(replyContext),
	});

	if (decision?.addressing === "direct") {
		return "full";
	}

	if (replyContext && !replyContext.isBot) {
		await observeConversationTurn(ctx, conversationContent, userName);
		return "handled";
	}

	await observeConversationTurn(ctx, conversationContent, userName);
	if (decision?.action !== "respond") {
		return "handled";
	}

	await processConversationAndTrackGroupContinuation(
		ctx,
		conversationContent,
		userName,
		"name",
		isBotOff(),
		isSleepingHour(),
		undefined,
		options?.isVoiceMessage,
		undefined,
		buildGroupResponseOptions({
			groupAutoReply: decision.addressing !== "continuation",
			groupContinuation: decision.addressing === "continuation",
		}),
	);

	return "handled";
}
