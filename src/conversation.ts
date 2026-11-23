import { trackBackground } from "./background-tasks.ts";
import { drainPromotionSpool } from "./memory/promotion.ts";
import { retrieveMemoryContext } from "./prompt/retrieval.ts";

export {
	drainPromotionSpool,
	promoteToMemoryReliably,
	retrySpooledPromotions,
} from "./memory/promotion.ts";

import type { Context } from "grammy";
import { classifyRepeatedSelfie } from "./ai/classifiers.ts";
import { generateResponse } from "./ai/core.ts";
import { describeImage } from "./ai/vision.ts";
import { alertOwner, errorSummary } from "./alerts.ts";
import { startChatAction } from "./chat-actions.ts";
import { logBotMessage, logUserMessage } from "./chat-logger.ts";
import { checkAndSendTaskBehaviors } from "./commitments/behavior-runner.ts";
import type { ReviewReportDraft } from "./commitments/requests.ts";
import { handleCommitmentRequest } from "./commitments/requests.ts";
import {
	generateScheduledDelivery,
	type ScheduledMessage,
} from "./commitments/runner.ts";
import type { ScheduledTask } from "./commitments/schema.ts";
import { loadConfig } from "./config.ts";
import {
	checkAndCancelResolvedFollowUps,
	detectAndStoreFollowUps,
} from "./follow-ups.ts";
import {
	type GroupRequestDecision,
	releaseGroupReconsideration,
	rememberGroupRefusal,
	resolveGroupRequest,
} from "./group-autonomy.ts";
import {
	groupMemberTurn,
	groupPersonalityEnabled,
} from "./group-personality.ts";
import {
	CONSERVATIVE_GROUP_POSTURE,
	recordGroupRelationshipTurn,
} from "./group-relationships.ts";
import { restoreGroupFavorEvidence } from "./group-request-evidence.ts";
import { registerIdentity } from "./identities.ts";
import {
	formatImageDimensions,
	getMessageImage,
	prepareImageContext,
	readImageDimensions,
	selectRecentImage,
} from "./image-context.ts";
import { shouldGenerateImageNow } from "./image-scheduler.ts";
import { log } from "./logger.ts";
import { cleanupFile } from "./media-handlers.ts";
import {
	addMessageToSensory,
	loadSensory,
	passivePromotionBar,
	reinforceRecalledFacts,
	withChatLock,
} from "./memory/index.ts";
import {
	currentOperationSignal,
	isTimeoutError,
} from "./operation-deadline.ts";
import { assembleSystemPrompt } from "./prompt/assemble.ts";
import { buildPromptContext } from "./prompt/context.ts";
import { buildMessages } from "./prompt/history.ts";
import { isFullAccessActive, isSimpleAssistantMode } from "./prompt/modes.ts";
import type { MediaAttachment } from "./providers/types.ts";
import { ResearchFailure, researchFailureNotice } from "./research-failure.ts";
import { parseResponse } from "./response-plan.ts";
import { type SendResponseResult, sendResponse } from "./response-processor.ts";
import { crossedSelfieDelivery, selfieContext } from "./selfie-continuity.ts";
import { timeoutReply } from "./telegram-delivery.ts";
import { isTtsAvailable } from "./tts/index.ts";
import type { ConversationMessage, MentionType } from "./types.ts";
import { type ConversationWeatherContext, weatherService } from "./weather.ts";
import {
	type ConversationWebContext,
	generateWithWebSearch,
} from "./web-conversation.ts";
import { worldContext } from "./world-context.ts";

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

function ownTurnText(ctx: Context, transcription?: string): string | undefined {
	if (!ctx.message || ctx.message.forward_origin) return undefined;
	return transcription ?? ctx.message.text ?? ctx.message.caption;
}

export interface ConversationOptions {
	mentionType?: MentionType;
	botOff?: boolean;
	isSleepingHour?: boolean;
	mediaAttachment?: MediaAttachment;
	isVoiceMessage?: boolean;
	userImagePath?: string;
	imageDescription?: string;
	skipHistoricalContext?: boolean;
	userTurnAlreadyRecorded?: boolean;
	groupAutoReply?: boolean;
	groupContinuation?: boolean;
	groupRequestDecision?: GroupRequestDecision;
	onGroupContribution?: () => void;
	/** Current speaker's own transcription, never a quoted audio or page body. */
	directUserText?: string;
}
export interface ConversationDependencies {
	repeatedSelfie: typeof classifyRepeatedSelfie;
	generate: typeof generateResponse;
	retrieve: typeof retrieveMemoryContext;
	send: typeof sendResponse;
	assemble: typeof assembleSystemPrompt;
	prepareImage: typeof prepareImageContext;
	web: ConversationWebContext;
	weather: ConversationWeatherContext;
	commitments: typeof handleCommitmentRequest;
	scheduled: (task: ScheduledTask) => Promise<ScheduledMessage | string>;
	behaviors?: typeof checkAndSendTaskBehaviors;
	groupRelationship?: typeof recordGroupRelationshipTurn;
	groupRequest?: typeof resolveGroupRequest;
	restoreGroupEvidence?: typeof restoreGroupFavorEvidence;
}
export const defaultConversationDependencies: ConversationDependencies = {
	repeatedSelfie: classifyRepeatedSelfie,
	generate: generateResponse,
	retrieve: retrieveMemoryContext,
	send: sendResponse,
	assemble: assembleSystemPrompt,
	prepareImage: prepareImageContext,
	web: worldContext,
	weather: weatherService,
	commitments: handleCommitmentRequest,
	scheduled: generateScheduledDelivery,
	behaviors: checkAndSendTaskBehaviors,
};

function groupRelationshipInput(
	ctx: Context,
	text: string | undefined,
	userName: string,
	recentMessages: readonly ConversationMessage[],
	addressedToBot?: boolean,
) {
	const source = groupMemberTurn(ctx);
	if (!source || !text?.trim()) return undefined;
	const reply = ctx.message?.reply_to_message;
	const replyIsBot = reply?.from?.id === ctx.me.id;
	return {
		...source,
		messageAt: ctx.message?.date ? ctx.message.date * 1000 : undefined,
		userName,
		botName: loadConfig().botName,
		text,
		recentMessages,
		addressedToBot: addressedToBot || replyIsBot || undefined,
		replyTo: reply && {
			recipient: replyIsBot
				? ("bot" as const)
				: reply.from && !reply.from.is_bot
					? ("human" as const)
					: ("unknown" as const),
			text: reply.text ?? reply.caption,
		},
	};
}

async function generateFavorRefusal(
	generate: ConversationDependencies["generate"],
	systemPrompt: string,
	messages: ReturnType<typeof buildMessages>,
) {
	try {
		const result: unknown = JSON.parse(
			await generate(
				`${systemPrompt}\n\nYou have already decided to decline this favor. Express that naturally in one short line in the speaker's language. Keep the configured voice and make it clear that you are passing on the favor. Make no promise and do not invoke any tool, media, reaction or scheduling control. Return only JSON with a single text property.`,
				messages,
			),
		);
		if (
			result &&
			typeof result === "object" &&
			"text" in result &&
			typeof result.text === "string" &&
			result.text.trim()
		)
			return result.text.trim().slice(0, 500);
	} catch {
		currentOperationSignal()?.throwIfAborted();
	}
	return loadConfig().language === "en"
		? "I'll pass this time."
		: "Esta vez paso.";
}

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
		isVoiceMessage,
	} = options;
	let { mediaAttachment, userImagePath } = options;
	let recoveredImagePath: string | undefined;
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
	if (options.groupRequestDecision?.kind === "handled") return false;

	// Immediate receipt feedback: show "typing…" from the moment we start
	// working on a reply — retrieval plus generation can take many seconds.
	// sendResponse switches the indicator per modality (photo/voice) via the
	// shared handle, and the finally below always clears it.
	const typing =
		options.groupAutoReply && groupPersonalityEnabled()
			? undefined
			: startChatAction(ctx, "typing");
	const onGroupContribution = options.onGroupContribution;
	let result: SendResponseResult | null;
	let deliveredReportId: string | undefined;
	try {
		// Register identity for this user
		const { userId, username } = getUserInfo(ctx);
		const directUserText = ownTurnText(ctx, options.directUserText);
		if (userId) {
			await registerIdentity(userId, userName, username);
		}

		// Load sensory buffer and append the user turn atomically per chat.
		const incomingImage = getMessageImage(ctx);
		if (incomingImage && !incomingImage.dimensions && userImagePath)
			incomingImage.dimensions = await readImageDimensions(userImagePath);
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
					userText: directUserText,
					userTextVerified: directUserText === undefined ? undefined : true,
					timestamp: Date.now(),
					image: incomingImage,
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
		const recentGroupMessages = buffer.messages.slice(0, -1);
		const groupTurn = groupRelationshipInput(
			ctx,
			directUserText,
			userName,
			recentGroupMessages,
			mentionType !== "none" || options.groupContinuation === true,
		);
		const groupRelationship = groupTurn
			? await (dependencies.groupRelationship ?? recordGroupRelationshipTurn)(
					groupTurn,
				)
			: isGroupChat(ctx) && groupPersonalityEnabled()
				? CONSERVATIVE_GROUP_POSTURE
				: undefined;
		const requestDecision =
			options.groupRequestDecision ??
			(groupTurn?.addressedToBot &&
			!options.groupAutoReply &&
			!groupRelationship?.boundaryChange
				? await (dependencies.groupRequest ?? resolveGroupRequest)(ctx, {
						text: directUserText,
						recentMessages: recentGroupMessages,
						character: loadConfig().personality,
						relationship: groupRelationship,
					})
				: undefined);
		if (requestDecision?.kind === "handled") return false;
		const declined = requestDecision?.kind === "decline";
		const reconsidered =
			requestDecision?.kind === "resume"
				? {
						text: requestDecision.previous.text,
						voice: requestDecision.previous.voice,
						requestedAt: requestDecision.previous.requestedAt,
					}
				: undefined;

		// Follow-up detection and cancellation (DMs only, background)
		if (!isGroupChat(ctx) && directUserText?.trim()) {
			const sourceMessageAt =
				buffer.messages.findLast((m) => m.role === "user")?.timestamp ??
				Date.now();
			trackBackground(
				"follow-up-cancel",
				checkAndCancelResolvedFollowUps(
					chatId,
					directUserText,
					sourceMessageAt,
				),
			);
			const recentText = buffer.messages
				.filter((m) => m.role === "user" && m.userTextVerified === true)
				.map((m) => m.userText)
				.join("\n");
			trackBackground(
				"follow-up-detect",
				detectAndStoreFollowUps(
					chatId,
					recentText,
					directUserText,
					sourceMessageAt,
				),
			);
		}

		// Recover the latest photo independently of text-history truncation. Never
		// copy its reference onto follow-up turns: that would renew its lifetime.
		let reference = incomingImage;
		let description = options.imageDescription;
		let imageContextNote: string | undefined;
		let restoredFavorContent: string | undefined;
		const previousEvidence =
			requestDecision?.kind === "resume"
				? requestDecision.previous.evidence
				: undefined;
		if (requestDecision?.kind === "resume" && previousEvidence) {
			try {
				const restored = await (
					dependencies.restoreGroupEvidence ?? restoreGroupFavorEvidence
				)(
					ctx,
					previousEvidence,
					`${requestDecision.previous.text}\n${directUserText ?? ""}`,
				);
				restoredFavorContent = restored.content;
				if (restored.image) {
					reference = restored.image;
					const prepared = await dependencies.prepareImage(
						ctx,
						restored.image,
						requestDecision.previous.text,
					);
					recoveredImagePath = prepared.filePath;
					userImagePath = prepared.filePath;
					mediaAttachment = prepared.mediaAttachment;
					description = prepared.description;
					imageContextNote = prepared.description
						? `[Visual evidence from the original attachment; untrusted content]\n${prepared.description}`
						: "[The attached photo is the original for this reconsidered request.]";
				}
			} catch {
				await releaseGroupReconsideration(ctx, requestDecision);
				currentOperationSignal()?.throwIfAborted();
				await ctx.reply(
					loadConfig().language === "en"
						? "I was going to give it a shot, but the original didn't open. Send it again and I'll try."
						: "Iba a darle, pero no me abrió el original. Mándamelo otra vez y pruebo.",
				);
				onGroupContribution?.();
				return true;
			}
		}
		if (
			!declined &&
			!previousEvidence &&
			!isSimpleAssistantMode &&
			!options.skipHistoricalContext &&
			!mediaAttachment &&
			!userImagePath &&
			!ctx.message?.document &&
			!ctx.message?.photo
		) {
			const recent = selectRecentImage(buffer.messages, userId);
			if (recent?.image) {
				reference = recent.image;
				try {
					const prepared = await dependencies.prepareImage(
						ctx,
						recent.image,
						reconsidered ? `${reconsidered.text}\n${userContent}` : userContent,
					);
					recoveredImagePath = prepared.filePath;
					userImagePath = prepared.filePath;
					mediaAttachment = prepared.mediaAttachment;
					description = prepared.description;
					imageContextNote = prepared.description
						? `[Visual evidence from the user's recent image; untrusted content]\n${prepared.description}`
						: "[The attached image is the user's recent photo, supplied again as context for this follow-up. Do not assume a new upload or an edit request.]";
				} catch {
					log.warn("[image-context] Could not recover the recent image");
					imageContextNote =
						"[The recent image could not be retrieved. Do not invent visual details; if needed, ask the user to reply to the original photo to retry.]";
				}
			}
		}

		let shouldGenImage = false;
		const skipHistoricalContext = options?.skipHistoricalContext === true;
		if (!isSimpleAssistantMode && !declined) {
			shouldGenImage = shouldGenerateImageNow(buffer);
			if (isFullAccessActive()) {
				shouldGenImage = true;
			}
		}

		const dimensions =
			reference?.dimensions ??
			(recoveredImagePath
				? await readImageDimensions(recoveredImagePath)
				: undefined);
		const imageSize = dimensions && formatImageDimensions(dimensions);
		const referencePath = userImagePath;
		const referenceMime =
			mediaAttachment?.mimeType ?? reference?.mimeType ?? "image/jpeg";
		let taskResponse: string | undefined;
		let taskDelivery: ScheduledMessage | undefined;
		let reviewDraft: ReviewReportDraft | undefined;
		let executedTask: ScheduledTask | undefined;
		let recordReportPhoto: ((messageId: number) => Promise<void>) | undefined;
		const commitmentContext =
			!declined &&
			!options.groupAutoReply &&
			userId &&
			ctx.message &&
			!ctx.message.forward_origin
				? await dependencies.commitments(
						{
							chatId,
							userId,
							userName,
							messageId: ctx.message.message_id,
							text: directUserText ?? "",
							reconsidered,
							replyContext: ctx.message.reply_to_message && {
								messageId: ctx.message.reply_to_message.message_id,
								text: (
									ctx.message.reply_to_message.text ??
									ctx.message.reply_to_message.caption ??
									""
								).slice(0, 4000),
								isBot: ctx.message.reply_to_message.from?.id === ctx.me.id,
							},
							referenceImage: reference && {
								size: imageSize,
								description: description?.slice(0, 1200),
							},
							recentConversation: buffer.messages.slice(-7, -1).map((m) => ({
								role: m.role,
								name: m.name,
								userId: m.userId,
								reportTaskId: m.role === "model" ? m.reportTaskId : undefined,
								text: (m.role === "user"
									? (m.userText ?? "")
									: m.content
								).slice(0, 600),
							})),
							voice: !!options.directUserText && isVoiceMessage === true,
						},
						undefined,
						{
							onReportReview: (review) => {
								reviewDraft = review;
							},
							describeReference:
								referencePath && reference
									? () =>
											describeImage(
												referencePath,
												referenceMime,
												"Describe the reusable visual design: orientation, colors, arrangement, headings and column order. Omit dated values.",
											)
									: undefined,
							reply: (text) => {
								taskResponse = text;
							},
							run: async (task, recordPhoto) => {
								try {
									const delivery = await dependencies.scheduled(task);
									taskDelivery =
										typeof delivery === "string"
											? { text: delivery }
											: delivery;
									taskResponse = taskDelivery.text;
									executedTask = task;
									recordReportPhoto = recordPhoto;
								} catch (error) {
									currentOperationSignal()?.throwIfAborted();
									log.error("[agenda] Manual report failed:", error);
									await alertOwner("manual-report", errorSummary(error));
									taskResponse = researchFailureNotice(error);
								}
							},
						},
					)
				: "";
		const lastSelfie =
			!declined &&
			!isSimpleAssistantMode &&
			directUserText &&
			taskResponse === undefined
				? buffer.lastSelfie
				: undefined;
		const messageId = ctx.message?.message_id;
		// Telegram can replay the source update after a restart.
		if (messageId && lastSelfie?.requestMessageId === messageId) return false;
		let uncertainOverlap = false;
		if (
			lastSelfie &&
			messageId &&
			directUserText &&
			crossedSelfieDelivery(lastSelfie, messageId)
		) {
			const reply = ctx.message?.reply_to_message;
			const repeat = await dependencies.repeatedSelfie({
				originalRequest: lastSelfie.requestText,
				sameSpeaker: lastSelfie.requesterId === userId,
				currentMessage: directUserText.slice(0, 2000),
				replyTarget: (reply?.text ?? reply?.caption)?.slice(0, 500),
				recentMessages: buffer.messages
					.slice(-6, -1)
					.map((m) => `${m.name ?? m.role}: ${m.content.slice(0, 400)}`),
			});
			if (repeat) return false;
			uncertainOverlap = repeat === null;
		}
		let responseText = taskResponse;
		if (responseText === undefined) {
			const memory =
				isSimpleAssistantMode || skipHistoricalContext || declined
					? { relevantEpisodes: [], relevantFacts: [] }
					: await dependencies.retrieve({
							chatId,
							messages: buffer.messages,
							relevantOnly: true,
						});
			const promptCtx = buildPromptContext({
				...memory,
				mentionType: isGroupChat(ctx) ? mentionType : undefined,
				groupAutoReply: options.groupAutoReply,
				groupContinuation: options.groupContinuation,
				groupRelationship,
				isVoiceMessage,
				userAttachedImage: !!userImagePath,
				shouldGenerateImage: shouldGenImage,
				allowPhotoRequest,
				ttsAvailable: isTtsAvailable(),
			});
			const renderedFactIds = new Set<string>();
			const systemPrompt =
				(await dependencies.assemble(promptCtx, renderedFactIds)) +
				(commitmentContext ||
					"\nNo scheduling result is available for this turn. Do not promise to check an event or send something later.") +
				(lastSelfie && messageId
					? selfieContext(
							lastSelfie,
							messageId,
							shouldGenImage || allowPhotoRequest,
							ctx.message?.reply_to_message?.photo?.at(-1)?.file_id ===
								lastSelfie.fileId,
						)
					: "");
			const messages = buildMessages(buffer, mediaAttachment);
			const latest = messages.findLast((message) => message.role === "user");
			if (latest) {
				const prior =
					reconsidered ??
					(requestDecision?.kind === "decline"
						? requestDecision.previous
						: undefined);
				if (prior)
					latest.content += `\n\n[Earlier favor requested by the same speaker and brought up again in this turn]\n${JSON.stringify(prior.text)}`;
				if (restoredFavorContent)
					latest.content += `\n\n${restoredFavorContent}`;
				if (imageContextNote) latest.content += `\n\n${imageContextNote}`;
				if (imageSize)
					latest.content += `\n\n[Reference image dimensions: ${imageSize}]`;
			}

			let deferred: (() => Promise<void>) | undefined;
			responseText = declined
				? await generateFavorRefusal(
						dependencies.generate,
						systemPrompt,
						messages,
					)
				: await generateWithWebSearch({
						systemPrompt,
						messages,
						chatId,
						generate: dependencies.generate,
						web: dependencies.web,
						weather: dependencies.weather,
						useCachedContext: !skipHistoricalContext,
						interceptFirstLookup:
							reviewDraft &&
							(async (proposal) => {
								deferred = await reviewDraft?.(proposal);
								return !!deferred;
							}),
						announce: async (notice) => {
							await ctx.reply(notice);
							onGroupContribution?.();
							trackBackground("chat-log", logBotMessage(notice));
						},
					});
			if (reviewDraft && !deferred) {
				const candidate = parseResponse(responseText, {
					allowImages: shouldGenImage || allowPhotoRequest,
					allowImageEdits: !!userImagePath,
					allowSpeech: false,
				}).image;
				if (candidate && !candidate.self)
					deferred = await reviewDraft(candidate.prompt);
			}
			if (deferred) {
				await deferred();
				responseText = taskResponse ?? responseText;
			}
			if (renderedFactIds.size)
				trackBackground(
					"retrieval-reinforcement",
					reinforceRecalledFacts([...renderedFactIds]),
				);
		}
		// Refresh ambient news only during active use, without delaying this reply or
		// sending a bulletin. The shared service limits this to one attempt per day.
		if (
			!declined &&
			taskResponse === undefined &&
			dependencies.web.isEnabled() &&
			!isSimpleAssistantMode &&
			!skipHistoricalContext
		) {
			trackBackground("news-context", dependencies.web.refreshHeadlines());
		}

		// Process and send the response
		result = await dependencies.send({
			ctx,
			responseText,
			textOnly: declined,
			lastSelfie: taskResponse === undefined ? lastSelfie : undefined,
			requestText: directUserText,
			uncertainOverlap,
			preparedImage: taskDelivery?.image,
			preparedImageOnly: taskDelivery?.delivery === "image_only",
			shouldGenImage: taskResponse === undefined && shouldGenImage,
			allowPhotoRequest,
			buffer,
			isGroup: isGroupChat(ctx),
			userImagePath,
			chatAction: typing,
		});
		if (result?.sent) {
			onGroupContribution?.();
			if (requestDecision?.kind === "decline")
				await rememberGroupRefusal(
					ctx,
					directUserText,
					isVoiceMessage === true,
					requestDecision,
				);
		}
		if (result?.sent) deliveredReportId = executedTask?.id;
		if (result?.preparedPhotoId && recordReportPhoto)
			await recordReportPhoto(result.preparedPhotoId).catch(() =>
				log.warn("[agenda] Could not record delivered report photo reference"),
			);
		if (
			result?.sent &&
			executedTask &&
			taskDelivery?.observation &&
			dependencies.behaviors
		)
			await dependencies
				.behaviors(ctx.api, executedTask, taskDelivery.observation)
				.catch(() =>
					log.warn(
						"[behaviors] Conditional action failed after manual report delivery",
					),
				);
	} catch (error) {
		if (error instanceof ResearchFailure) {
			log.error("[conversation] Research failed:", error);
			await alertOwner("research-failure", `Research failed (${error.code})`);
			await ctx.reply(researchFailureNotice(error));
			onGroupContribution?.();
			return false;
		}
		if (!isTimeoutError(error)) throw error;
		log.warn("[conversation] Provider deadline exceeded");
		await ctx.reply(timeoutReply(loadConfig().language));
		onGroupContribution?.();
		return false;
	} finally {
		typing?.stop();
		if (recoveredImagePath) await cleanupFile(recoveredImagePath);
	}

	// Save bot response to sensory buffer (only if non-silenced and non-empty)
	const didRespond = result?.sent === true;
	if (result && didRespond && result.cleanedText.trim()) {
		const botMessage: ConversationMessage = {
			role: "model",
			content: result.cleanedText,
			reportTaskId: deliveredReportId,
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
	transcription?: string,
	addressedToBot?: boolean,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;

	const { userId, username } = getUserInfo(ctx);
	const userText = ownTurnText(ctx, transcription);
	if (userId) {
		await registerIdentity(userId, userName, username);
	}

	const { overflow, recentMessages } = await withChatLock(chatId, async () => {
		const buffer = await loadSensory(chatId);
		const recentMessages = [...buffer.messages];
		const userMessage: ConversationMessage = {
			role: "user",
			name: userName,
			userId,
			content: userContent,
			userText,
			userTextVerified: userText === undefined ? undefined : true,
			timestamp: Date.now(),
			image: getMessageImage(ctx),
		};
		const overflow = await addMessageToSensory(buffer, userMessage, {
			minImportance: passivePromotionBar(),
			source: "passive",
		});
		return { overflow, recentMessages };
	});
	trackBackground("chat-log", logUserMessage(userName, userContent));

	// Passively witnessed messages (the bot wasn't addressed) still get a shot
	// at long-term memory, but only above a higher importance bar so ambient
	// group noise doesn't accumulate.
	if (overflow) {
		trackBackground("promotion", drainPromotionSpool(chatId));
	}
	const groupTurn = groupRelationshipInput(
		ctx,
		userText,
		userName,
		recentMessages,
		addressedToBot,
	);
	if (groupTurn)
		trackBackground(
			"group-relationship",
			recordGroupRelationshipTurn(groupTurn),
		);
}
