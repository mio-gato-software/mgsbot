// Shared routing helpers for the message handlers: mention detection,
// reply-context builders, passive group voice gating, and the group
// turn classifier. Used by the core text handler plus the voice and
// photo handler modules.
import type { Context } from "grammy";
import {
	classifyEditIntent,
	classifyGroupSocialIntent,
} from "../ai/classifiers.ts";
import { getBotName } from "../config.ts";
import { isGroupChat, processConversation } from "../conversation.ts";
import { openGroupContinuationWindow } from "../group-state.ts";
import { loadSensory } from "../memory/index.ts";
import type { MentionType } from "../types.ts";

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

/** When edit intent is uncertain, retain the ordinary image-analysis path. */
export async function hasEditIntent(caption?: string): Promise<boolean> {
	return caption ? (await classifyEditIntent(caption)) === true : false;
}

export function detectMentionType(
	ctx: Context,
	botId: number,
): "reply" | "tag" | "none" {
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

	return "none";
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

export function truncatePassiveVoiceTranscript(text: string): string {
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
	return `[Voice message from ${userName}]: ${truncatePassiveVoiceTranscript(transcription)}`;
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

export async function classifyGroupTurn(
	ctx: Context,
	text: string,
	userName: string,
	imageAttached?: boolean,
) {
	const chatId = ctx.chat?.id;
	if (!chatId || !text.trim()) return null;
	const buffer = await loadSensory(chatId);
	return classifyGroupSocialIntent({
		mode: "message",
		botName: getBotName(),
		currentSpeaker: userName,
		currentMessage: text,
		imageAttached,
		recentMessages: buffer.messages,
		lastBotMessage: buffer.messages.findLast(
			(message) => message.role === "model",
		)?.content,
		replyContext: toClassifierReplyContext(
			getTelegramReplyContext(ctx, ctx.me.id),
		),
	});
}

export async function resolveMediaMention(
	ctx: Context,
	requestText: string | undefined,
	userName: string,
): Promise<MentionType> {
	const telegram = detectMentionType(ctx, ctx.me.id);
	if (telegram !== "none" || !isGroupChat(ctx) || !requestText) return telegram;
	const decision = await classifyGroupTurn(ctx, requestText, userName);
	return decision?.addressing === "direct" && decision.action === "respond"
		? "name"
		: "none";
}
