import { trackBackground } from "./background-tasks.ts";
import { drainPromotionSpool } from "./memory/promotion.ts";
import { retrieveMemoryContext } from "./prompt/retrieval.ts";

export {
	drainPromotionSpool,
	promoteToMemoryReliably,
	retrySpooledPromotions,
} from "./memory/promotion.ts";

import type { Context } from "grammy";
import { generateResponse } from "./ai/core.ts";
import { startChatAction } from "./chat-actions.ts";
import { logBotMessage, logUserMessage } from "./chat-logger.ts";
import {
	checkAndCancelResolvedFollowUps,
	detectAndStoreFollowUps,
} from "./follow-ups.ts";
import { registerIdentity } from "./identities.ts";
import { shouldGenerateImageNow } from "./image-scheduler.ts";
import { log } from "./logger.ts";
import {
	addMessageToSensory,
	loadSensory,
	passivePromotionBar,
	reinforceRecalledFacts,
	withChatLock,
} from "./memory/index.ts";
import { assembleSystemPrompt } from "./prompt/assemble.ts";
import { buildPromptContext } from "./prompt/context.ts";
import { buildMessages } from "./prompt/history.ts";
import { isFullAccessActive, isSimpleAssistantMode } from "./prompt/modes.ts";
import type { MediaAttachment } from "./providers/types.ts";
import { type SendResponseResult, sendResponse } from "./response-processor.ts";
import { isTtsAvailable } from "./tts/index.ts";
import type { ConversationMessage, MentionType } from "./types.ts";

export function isGroupChat(ctx: Context): boolean {
	const type = ctx.chat?.type;
	return type === "group" || type === "supergroup";
}

export function getUserDisplayName(ctx: Context): string {
	const user = ctx.from;
	if (!user) return "Unknown";
	return user.first_name && user.last_name
		? `${user.first_name} ${user.last_name}`
		: (user.first_name ?? user.username ?? "Unknown");
}

function getUserInfo(ctx: Context): {
	userId: number | undefined;
	username: string | undefined;
} {
	const user = ctx.from;
	if (!user) return { userId: undefined, username: undefined };
	return { userId: user.id, username: user.username };
}

export interface ConversationOptions {
	mentionType?: MentionType;
	botOff?: boolean;
	isSleepingHour?: boolean;
	mediaAttachment?: MediaAttachment;
	isVoiceMessage?: boolean;
	userImagePath?: string;
	skipHistoricalContext?: boolean;
	userTurnAlreadyRecorded?: boolean;
	groupAutoReply?: boolean;
	groupContinuation?: boolean;
}
export interface ConversationDependencies {
	generate: typeof generateResponse;
	retrieve: typeof retrieveMemoryContext;
	send: typeof sendResponse;
	assemble: typeof assembleSystemPrompt;
}
export const defaultConversationDependencies: ConversationDependencies = {
	generate: generateResponse,
	retrieve: retrieveMemoryContext,
	send: sendResponse,
	assemble: assembleSystemPrompt,
};

export async function processConversation(
	ctx: Context,
	userContent: string,
	userName: string,
	options: ConversationOptions = {},
	dependencies: ConversationDependencies = defaultConversationDependencies,
): Promise<boolean> {
	const {
		mentionType = "none",
		botOff = false,
		isSleepingHour = false,
		mediaAttachment,
		isVoiceMessage,
		userImagePath,
	} = options;
	const chatId = ctx.chat?.id;
	if (!chatId) return false;

	if (botOff || (isGroupChat(ctx) && isSleepingHour)) {
		try {
			await ctx.react("😴");
		} catch (error) {
			log.debug("[off] Error reacting:", error);
		}
		return false;
	}

	// Immediate receipt feedback: show "typing…" from the moment we start
	// working on a reply — retrieval plus generation can take many seconds.
	// sendResponse switches the indicator per modality (photo/voice) via the
	// shared handle, and the finally below always clears it.
	const typing = startChatAction(ctx, "typing");
	let result: SendResponseResult | null;
	try {
		// Register identity for this user
		const { userId, username } = getUserInfo(ctx);
		if (userId) {
			await registerIdentity(userId, userName, username);
		}

		// Load sensory buffer and append the user turn atomically per chat.
		const userTurnAlreadyRecorded = options?.userTurnAlreadyRecorded === true;
		const { buffer, overflow, allowPhotoRequest } = await withChatLock(
			chatId,
			async () => {
				const buf = await loadSensory(chatId);
				const allow = buf.allowPhotoRequest === true;
				if (userTurnAlreadyRecorded) {
					return { buffer: buf, overflow: null, allowPhotoRequest: allow };
				}
				const userMessage: ConversationMessage = {
					role: "user",
					name: userName,
					userId,
					content: userContent,
					timestamp: Date.now(),
				};
				const ov = await addMessageToSensory(buf, userMessage);
				return { buffer: buf, overflow: ov, allowPhotoRequest: allow };
			},
		);
		if (!userTurnAlreadyRecorded) {
			trackBackground("chat-log", logUserMessage(userName, userContent));
		}

		// Promote overflow to memory in background (spooled for retry on failure)
		if (overflow) {
			trackBackground("promotion", drainPromotionSpool(chatId));
		}

		// Follow-up detection and cancellation (DMs only, background)
		if (!isGroupChat(ctx)) {
			trackBackground(
				"follow-up-cancel",
				checkAndCancelResolvedFollowUps(chatId, userContent),
			);
			const recentText = buffer.messages
				.filter((m) => m.role === "user")
				.map((m) => m.content)
				.join("\n");
			trackBackground(
				"follow-up-detect",
				detectAndStoreFollowUps(chatId, recentText, userContent),
			);
		}

		// Build prompt and messages
		let shouldGenImage = false;
		let promptCtx: Parameters<typeof assembleSystemPrompt>[0];
		const skipHistoricalContext = options?.skipHistoricalContext === true;
		if (!isSimpleAssistantMode) {
			shouldGenImage = shouldGenerateImageNow(buffer);
			if (isFullAccessActive()) {
				shouldGenImage = true;
			}
		}

		if (isSimpleAssistantMode || skipHistoricalContext) {
			promptCtx = buildPromptContext({
				relevantEpisodes: [],
				relevantFacts: [],
				mentionType: isGroupChat(ctx) ? mentionType : undefined,
				groupAutoReply: options?.groupAutoReply === true,
				groupContinuation: options?.groupContinuation === true,
				isVoiceMessage,
				userAttachedImage: !!userImagePath,
				shouldGenerateImage: shouldGenImage,
				allowPhotoRequest,
				ttsAvailable: isTtsAvailable(),
			});
		} else {
			const context = await dependencies.retrieve({
				chatId,
				messages: buffer.messages,
			});
			if (context.relevantFacts.length) {
				trackBackground(
					"retrieval-reinforcement",
					reinforceRecalledFacts(context.relevantFacts.map((fact) => fact.id)),
				);
			}
			promptCtx = buildPromptContext({
				...context,
				mentionType: isGroupChat(ctx) ? mentionType : undefined,
				groupAutoReply: options.groupAutoReply,
				groupContinuation: options.groupContinuation,
				isVoiceMessage,
				userAttachedImage: !!userImagePath,
				shouldGenerateImage: shouldGenImage,
				allowPhotoRequest,
				ttsAvailable: isTtsAvailable(),
			});
		}

		const systemPrompt = await dependencies.assemble(promptCtx);
		const messages = buildMessages(buffer, mediaAttachment);

		// Generate response
		const responseText = await dependencies.generate(systemPrompt, messages);

		// Process and send the response
		result = await dependencies.send({
			ctx,
			responseText,
			shouldGenImage,
			allowPhotoRequest,
			buffer,
			isGroup: isGroupChat(ctx),
			userImagePath,
			chatAction: typing,
		});
	} finally {
		typing.stop();
	}

	// Save bot response to sensory buffer (only if non-silenced and non-empty)
	const didRespond = result?.sent === true;
	if (result && didRespond && result.cleanedText.trim()) {
		const botMessage: ConversationMessage = {
			role: "model",
			content: result.cleanedText,
			timestamp: Date.now(),
		};
		// Serialize per chat: a concurrent user turn arriving right now must not
		// race with this append. Reload the buffer under the lock so we don't
		// clobber its state with the stale in-memory copy.
		const botOverflow = await withChatLock(chatId, async () => {
			const fresh = await loadSensory(chatId);
			return addMessageToSensory(fresh, botMessage);
		});
		trackBackground("chat-log", logBotMessage(result.cleanedText));

		// Promote bot overflow too (spooled for retry on failure)
		if (botOverflow) {
			trackBackground("promotion", drainPromotionSpool(chatId));
		}
	}

	return didRespond;
}

export async function observeConversationTurn(
	ctx: Context,
	userContent: string,
	userName: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const { userId, username } = getUserInfo(ctx);
	if (userId) {
		await registerIdentity(userId, userName, username);
	}

	const overflow = await withChatLock(chatId, async () => {
		const buffer = await loadSensory(chatId);
		const userMessage: ConversationMessage = {
			role: "user",
			name: userName,
			userId,
			content: userContent,
			timestamp: Date.now(),
		};
		return addMessageToSensory(buffer, userMessage, {
			minImportance: passivePromotionBar(),
			source: "passive",
		});
	});
	trackBackground("chat-log", logUserMessage(userName, userContent));

	// Passively witnessed messages (the bot wasn't addressed) still get a shot
	// at long-term memory, but only above a higher importance bar so ambient
	// group noise doesn't accumulate.
	if (overflow) {
		trackBackground("promotion", drainPromotionSpool(chatId));
	}
}
