import type { Bot, Context } from "grammy";
import { analyzeYouTube, classifyEditIntent, describeImage } from "./ai.ts";
import { getBotHour, getBotMinute } from "./bot-time.ts";
import { getBotName, isBotConfigured, loadConfig } from "./config.ts";
import {
	getUserDisplayName,
	isGroupChat,
	processConversation,
} from "./conversation.ts";
import {
	cleanupFile,
	downloadAndTranscribe,
	downloadAndTranscribeByFileId,
	downloadImage,
	extractYouTubeUrl,
} from "./media-handlers.ts";
import { decayConfidence, loadSensory, saveSensory } from "./memory.ts";
import { isSimpleAssistantMode } from "./prompt/modes.ts";
import {
	createChatProvider,
	getChatProviderInfo,
	switchChatProvider,
} from "./providers/index.ts";
import { supportsInlineImages } from "./providers/types.ts";
import { processSetupConversation } from "./setup.ts";

const ALLOWED_GROUP_ID = Number(process.env.ALLOWED_GROUP_ID);
const OWNER_USER_ID = Number(process.env.OWNER_USER_ID);
const isDev = process.env.NODE_ENV === "development";
const showTranscription = process.env.SHOW_TRANSCRIPTION === "true";

/**
 * Regex fallback for edit intent detection when the LLM classifier is unavailable.
 */
const EDIT_INTENT_REGEX =
	/\b(edit|change|modify|add|remove|make it|turn it|turn this|transform|replace|paint|convert|crop|resize|edita|edítala|edítalo|cambia|cámbiale|modifica|modifícala|modifícalo|ponle|pónle|agrégale|agregale|añádele|añadele|quítale|quitale|hazla|hazlo|haz que|conviértela|conviertela|conviértelo|conviertelo|transforma|pinta|píntala|pintalo|reemplaza|sustituye)\b/i;

/**
 * Does the caption express intent to edit/modify the image?
 * When true, we can skip describeImage since the model will likely emit
 * [IMAGE: ...] and the edit provider uses the raw image directly.
 *
 * Uses an LLM classifier for nuance; falls back to a regex if the classifier
 * fails or is inconclusive.
 */
async function hasEditIntent(caption?: string): Promise<boolean> {
	if (!caption) return false;
	const classification = await classifyEditIntent(caption);
	if (classification !== null) return classification;
	return EDIT_INTENT_REGEX.test(caption);
}

let botOff = false;

export function isBotOff(): boolean {
	return botOff;
}

const enableSleepSchedule = process.env.ENABLE_SLEEP_SCHEDULE !== "false";

export function isSleepingHour(): boolean {
	if (!enableSleepSchedule) return false;
	const hour = getBotHour();
	const minute = getBotMinute();
	// 11:30 PM (23:30) to 6:00 AM
	return hour < 6 || (hour === 23 && minute >= 30);
}

export type { MentionType } from "./types.ts";

export function detectMentionType(ctx: Context, botId: number): MentionType {
	// Check if replied to the bot - always respond
	if (ctx.message?.reply_to_message?.from?.id === botId) return "reply";

	const entities = ctx.message?.entities ?? [];
	const text = ctx.message?.text ?? ctx.message?.caption ?? "";

	// Check if @mentioned - always respond
	for (const entity of entities) {
		if (entity.type === "mention") {
			const mention = text.slice(entity.offset, entity.offset + entity.length);
			if (mention === `@${ctx.me?.username}`) return "tag";
		}
	}

	// Check if called by name - AI decides if addressed or just mentioned
	const botName = getBotName().toLowerCase();
	const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const nameRegex = new RegExp(`\\b${escaped}\\b`, "i");
	if (nameRegex.test(text)) return "name";

	return "none";
}

export function registerHandlers(bot: Bot): void {
	const botToken = bot.token;

	// Run confidence decay on startup
	decayConfidence().catch(console.error);

	// Security: only allow the owner (DMs) and the permitted group
	bot.use(async (ctx, next) => {
		const chatId = ctx.chat?.id;
		if (isGroupChat(ctx)) {
			if (chatId !== ALLOWED_GROUP_ID) {
				console.log(`[guard] Unauthorized group ${chatId}, leaving...`);
				if (chatId) {
					await ctx.api
						.leaveChat(chatId)
						.catch((e) => console.error("[guard] Failed to leave:", e));
				}
				return;
			}
		} else if (ctx.from?.id !== OWNER_USER_ID) {
			console.log(
				`[guard] Unauthorized DM from user ${ctx.from?.id}, ignoring`,
			);
			const userId = ctx.from?.id;
			if (userId && ctx.message) {
				await ctx.reply(
					`⚠️ No tienes acceso a este bot.\n\nTu ID de usuario es: \`${userId}\`\n\nComparte este ID con la persona que administra el bot para que te dé acceso.`,
					{ parse_mode: "Markdown" },
				);
			}
			return;
		}

		if (!isBotConfigured()) {
			if (ctx.from?.id === OWNER_USER_ID && !isGroupChat(ctx)) {
				const text = ctx.message?.text;
				if (text) {
					const userName = getUserDisplayName(ctx);
					await processSetupConversation(ctx, text, userName);
				} else {
					const lang = loadConfig().language ?? "es";
					await ctx.reply(
						lang === "en"
							? "Please use text to configure the bot."
							: "Por favor, usa texto para configurar el bot.",
					);
				}
			}
			return;
		}

		await next();
	});

	// Voice messages
	bot.on("message:voice", async (ctx) => {
		const mentionType = detectMentionType(ctx, ctx.me.id);
		if (isGroupChat(ctx) && mentionType === "none") return;
		try {
			const transcription = await downloadAndTranscribe(
				ctx,
				botToken,
				"audio/ogg",
				"ogg",
				"voice",
			);
			if (showTranscription) {
				await ctx
					.reply(`📝 ${transcription}`, {
						reply_to_message_id: ctx.message?.message_id,
					})
					.catch(() => {});
			}
			const userName = getUserDisplayName(ctx);
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				botOff,
				isSleepingHour(),
				undefined,
				true,
			);
		} catch (error) {
			console.error("[voice handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Voice handler error: ${error}`).catch(() => {});
		}
	});

	// Audio files
	bot.on("message:audio", async (ctx) => {
		const mentionType = detectMentionType(ctx, ctx.me.id);
		if (isGroupChat(ctx) && mentionType === "none") return;
		try {
			const ext = ctx.message.audio.mime_type?.split("/")[1] ?? "mp3";
			const mimeType = ctx.message.audio.mime_type ?? "audio/mp3";
			const transcription = await downloadAndTranscribe(
				ctx,
				botToken,
				mimeType,
				ext,
				"audio",
			);
			if (showTranscription) {
				await ctx
					.reply(`📝 ${transcription}`, {
						reply_to_message_id: ctx.message?.message_id,
					})
					.catch(() => {});
			}
			const userName = getUserDisplayName(ctx);
			const content = `[Audio from ${userName}]: ${transcription}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				botOff,
				isSleepingHour(),
			);
		} catch (error) {
			console.error("[audio handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Audio handler error: ${error}`).catch(() => {});
		}
	});

	// Photos (disabled in simple assistant mode)
	bot.on("message:photo", async (ctx) => {
		if (isSimpleAssistantMode) return;
		const mentionType = detectMentionType(ctx, ctx.me.id);
		if (isGroupChat(ctx) && mentionType === "none") return;
		try {
			const { filePath, mimeType } = await downloadImage(ctx, botToken);
			const caption = ctx.message.caption;
			const userName = getUserDisplayName(ctx);
			const provider = createChatProvider();

			try {
				if (supportsInlineImages(provider)) {
					// Pass raw image inline (Gemini can see it)
					const imageBuffer = await Bun.file(filePath).arrayBuffer();
					const data = Buffer.from(imageBuffer).toString("base64");
					const content = caption
						? `[Image from ${userName}, caption: "${caption}"]`
						: `[Image from ${userName}]`;
					await processConversation(
						ctx,
						content,
						userName,
						mentionType,
						botOff,
						isSleepingHour(),
						{ data, mimeType },
						undefined,
						filePath,
					);
				} else {
					// Non-vision provider. Skip describeImage only when the caption
					// clearly expresses edit intent (the edit provider uses the raw
					// image directly). Otherwise describe so the bot can comment.
					const skipDescribe = await hasEditIntent(caption);
					let content: string;
					if (skipDescribe) {
						content = caption
							? `[Image from ${userName}, caption: "${caption}"]`
							: `[Image from ${userName}]`;
					} else {
						const description = await describeImage(
							filePath,
							mimeType,
							caption,
						);
						content = caption
							? `[Image from ${userName}, caption: "${caption}"]: ${description}`
							: `[Image from ${userName}]: ${description}`;
					}
					await processConversation(
						ctx,
						content,
						userName,
						mentionType,
						botOff,
						isSleepingHour(),
						undefined,
						undefined,
						filePath,
					);
				}
			} finally {
				await cleanupFile(filePath);
			}
		} catch (error) {
			console.error("[photo handler] Error:", error);
			if (isDev)
				await ctx.reply(`[Dev] Photo handler error: ${error}`).catch(() => {});
		}
	});

	// /provider command — switch chat provider (DM only, owner only)
	const VALID_PROVIDERS = [
		"gemini",
		"openrouter",
		"anthropic",
		"azure",
		"alibaba",
		"fireworks",
		"openai",
		"fal",
	] as const;

	bot.command("provider", async (ctx) => {
		if (isGroupChat(ctx)) return;

		const matchStr = typeof ctx.match === "string" ? ctx.match.trim() : "";
		const parts = matchStr.split(/\s+/).filter(Boolean);
		const providerArg = parts[0]?.toLowerCase() ?? "";
		const modelArg =
			parts.length > 1 ? parts.slice(1).join(" ").trim() : undefined;

		console.log(
			`[provider] Command received: "${matchStr}" from ${ctx.from?.id}`,
		);

		if (!providerArg) {
			const info = getChatProviderInfo();
			await ctx.reply(
				`Proveedor: ${info.provider}\nModelo: ${info.model}\n\nProveedores: ${VALID_PROVIDERS.join(", ")}`,
			);
			return;
		}

		if (
			!VALID_PROVIDERS.includes(providerArg as (typeof VALID_PROVIDERS)[number])
		) {
			await ctx.reply(
				`Uso:\n/provider — ver proveedor actual\n/provider <proveedor> [modelo]\n\nEjemplos:\n/provider gemini\n/provider openrouter meta-llama/llama-4-scout\n\nProveedores: ${VALID_PROVIDERS.join(", ")}`,
			);
			return;
		}

		try {
			const provider = switchChatProvider(providerArg, modelArg);
			await ctx.reply(
				`Cambiado a proveedor: ${provider.name}\nModelo: ${provider.model}`,
			);
		} catch (error) {
			await ctx.reply(`Error cambiando proveedor: ${error}`);
		}
	});

	// /allowphotorequest command — allow one photo request (DM only, owner only)
	// Usage: /allowphotorequest → activates for this DM; /allowphotorequest group → activates for the group
	bot.command("allowphotorequest", async (ctx) => {
		if (isGroupChat(ctx)) return;

		const arg = ctx.match?.toString().trim().toLowerCase();
		const targetGroup = arg === "group" || arg === "grupo";

		if (targetGroup) {
			if (!Number.isFinite(ALLOWED_GROUP_ID)) {
				await ctx.reply(
					"Error: ALLOWED_GROUP_ID no está configurado correctamente.",
				);
				return;
			}
			try {
				const groupBuffer = await loadSensory(ALLOWED_GROUP_ID);
				groupBuffer.allowPhotoRequest = true;
				await saveSensory(groupBuffer);
				await ctx.reply(
					"✅ allowPhotoRequest activado para el grupo. La próxima solicitud directa de foto en el grupo enviará una imagen contextual y luego se desactivará automáticamente.",
				);
			} catch (error) {
				await ctx.reply(`Error activando allowPhotoRequest: ${error}`);
			}
		} else {
			const chatId = ctx.chat?.id;
			if (!chatId) return;
			try {
				const dmBuffer = await loadSensory(chatId);
				dmBuffer.allowPhotoRequest = true;
				await saveSensory(dmBuffer);
				await ctx.reply(
					"✅ allowPhotoRequest activado para este DM. La próxima solicitud directa de foto aquí enviará una imagen contextual y luego se desactivará automáticamente.",
				);
			} catch (error) {
				await ctx.reply(`Error activando allowPhotoRequest: ${error}`);
			}
		}
	});

	// /help command — show available commands (DM only, owner only)
	bot.command("help", async (ctx) => {
		if (isGroupChat(ctx)) return;

		await ctx.reply(
			[
				"*Comandos disponibles:*",
				"",
				"/help — Mostrar esta lista de comandos",
				"/provider — Ver o cambiar el proveedor de chat",
				"/allowphotorequest — Permitir 1 foto bajo petición en este DM (o `/allowphotorequest group` para el grupo)",
				"/on — Encender el bot",
				"/off — Apagar el bot",
				"/optimize — Optimizar memorias (decay de confianza)",
			].join("\n"),
			{ parse_mode: "Markdown" },
		);
	});

	// /off command — disable bot responses (DM only, owner only)
	bot.command("off", async (ctx) => {
		if (isGroupChat(ctx)) return;
		botOff = true;
		await ctx.reply("😴 Bot apagado. Responderé con 😴 hasta que uses /on.");
	});

	// /on command — re-enable bot responses (DM only, owner only)
	bot.command("on", async (ctx) => {
		if (isGroupChat(ctx)) return;
		botOff = false;
		await ctx.reply("✅ Bot encendido. Respondiendo normalmente.");
	});

	// /optimize command — decay confidence + report stats (DM only, owner only)
	bot.command("optimize", async (ctx) => {
		if (isGroupChat(ctx)) return;

		await ctx.reply("Optimizando memorias...");
		try {
			const result = await decayConfidence();
			await ctx.reply(
				`Optimizado:\n\nSemantic facts: ${result.total}\nEliminados por baja confianza: ${result.removed}`,
			);
		} catch (error) {
			await ctx.reply(`Error optimizando: ${error}`);
		}
	});

	// Text messages (catch-all)
	bot.on("message", async (ctx) => {
		const text = ctx.message.text;
		if (!text) return;
		if (text.startsWith("/")) return;
		const userName = getUserDisplayName(ctx);
		const mentionType = detectMentionType(ctx, ctx.me.id);

		// YouTube analysis disabled in simple assistant mode
		const yt = isSimpleAssistantMode ? null : extractYouTubeUrl(ctx);
		if (yt) {
			if (isGroupChat(ctx) && mentionType === "none") return;
			const analysis = await analyzeYouTube(
				yt.url,
				yt.remainingText || undefined,
			);
			const content = yt.remainingText
				? `[YouTube video from ${userName}, message: "${yt.remainingText}"]: ${analysis}`
				: `[YouTube video from ${userName}]: ${analysis}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				botOff,
				isSleepingHour(),
			);
			return;
		}

		// Reply-to-audio/photo: transcribe audio or describe image from replied message
		{
			const replyMsg = ctx.message.reply_to_message;
			const replyVoice = replyMsg?.voice;
			const replyAudio = replyMsg?.audio;
			const replyPhoto = replyMsg?.photo;

			if (replyVoice || replyAudio) {
				if (isGroupChat(ctx) && mentionType === "none") return;

				try {
					const fileId = replyVoice
						? replyVoice.file_id
						: (replyAudio?.file_id as string);
					const mimeType = replyVoice
						? "audio/ogg"
						: (replyAudio?.mime_type ?? "audio/mp3");
					const fileExtension = replyVoice
						? "ogg"
						: (mimeType.split("/")[1] ?? "mp3");
					const prefix = replyVoice ? "voice_reply" : "audio_reply";
					const replyMessageId = replyMsg?.message_id as number;

					const transcription = await downloadAndTranscribeByFileId(
						ctx.api,
						botToken,
						fileId,
						mimeType,
						fileExtension,
						prefix,
						replyMessageId,
					);

					const audioSenderUser = replyMsg?.from;
					const audioSender = audioSenderUser
						? (audioSenderUser.first_name ??
							audioSenderUser.username ??
							"Unknown")
						: "Unknown";

					const content = text
						? `[Audio from ${audioSender}, transcription requested by ${userName}]: ${transcription}\n\n${userName}'s message: "${text}"`
						: `[Audio from ${audioSender}, transcription requested by ${userName}]: ${transcription}`;

					await processConversation(
						ctx,
						content,
						userName,
						mentionType,
						botOff,
						isSleepingHour(),
					);
				} catch (error) {
					console.error("[reply-to-audio handler] Error:", error);
					if (isDev)
						await ctx
							.reply(`[Dev] Reply-to-audio error: ${error}`)
							.catch(() => {});
				}
				return;
			}

			// Reply-to-photo: describe image from replied message
			if (replyPhoto && replyPhoto.length > 0) {
				if (isGroupChat(ctx) && mentionType === "none") return;

				try {
					const photo = replyPhoto[replyPhoto.length - 1];
					if (!photo) throw new Error("No photo found in replied message");
					const file = await ctx.api.getFile(photo.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					if (isDev) console.log("[reply-to-photo] Downloading from:", url);

					const response = await fetch(url, {
						signal: AbortSignal.timeout(30_000),
					});
					if (!response.ok) {
						throw new Error(
							`Download failed: ${response.status} ${response.statusText}`,
						);
					}

					const ext = file.file_path?.split(".").pop() ?? "jpg";
					const mimeType = ext === "png" ? "image/png" : "image/jpeg";
					const replyMessageId = replyMsg?.message_id as number;
					const filePath = `./audios/photo_reply_${replyMessageId}.${ext}`;
					const imageBuffer = Buffer.from(await response.arrayBuffer());
					await Bun.write(filePath, imageBuffer);
					if (isDev)
						console.log(
							"[reply-to-photo] Saved to:",
							filePath,
							`(${imageBuffer.length} bytes)`,
						);

					const photoSenderUser = replyMsg?.from;
					const photoSender = photoSenderUser
						? (photoSenderUser.first_name ??
							photoSenderUser.username ??
							"Unknown")
						: "Unknown";

					const provider = createChatProvider();

					try {
						if (supportsInlineImages(provider)) {
							// Pass raw image inline (Gemini can see it)
							const data = imageBuffer.toString("base64");
							const content = text
								? `[Image from ${photoSender}]\n\n${userName}'s message: "${text}"`
								: `[Image from ${photoSender}]`;
							await processConversation(
								ctx,
								content,
								userName,
								mentionType,
								botOff,
								isSleepingHour(),
								{ data, mimeType },
								undefined,
								filePath,
							);
						} else {
							// Non-vision provider. Skip describeImage only when the
							// current message expresses edit intent.
							const skipDescribe = await hasEditIntent(text);
							let content: string;
							if (skipDescribe) {
								content = text
									? `[Image from ${photoSender}]\n\n${userName}'s message: "${text}"`
									: `[Image from ${photoSender}]`;
							} else {
								const replyCaption = replyMsg?.caption;
								const description = await describeImage(
									filePath,
									mimeType,
									replyCaption ?? undefined,
								);
								content = text
									? `[Image from ${photoSender}]: ${description}\n\n${userName}'s message: "${text}"`
									: `[Image from ${photoSender}]: ${description}`;
							}
							await processConversation(
								ctx,
								content,
								userName,
								mentionType,
								botOff,
								isSleepingHour(),
								undefined,
								undefined,
								filePath,
							);
						}
					} finally {
						await cleanupFile(filePath);
					}
				} catch (error) {
					console.error("[reply-to-photo handler] Error:", error);
					if (isDev)
						await ctx
							.reply(`[Dev] Reply-to-photo error: ${error}`)
							.catch(() => {});
				}
				return;
			}
		}

		// In groups, only respond when mentioned
		if (isGroupChat(ctx) && mentionType === "none") return;

		// Reply-to-text: include quoted message content for context
		const replyText = ctx.message.reply_to_message?.text;
		if (replyText) {
			const replySenderUser = ctx.message.reply_to_message?.from;
			const replySenderName = replySenderUser
				? (replySenderUser.first_name ?? replySenderUser.username ?? "Unknown")
				: "Unknown";
			const content = `[Respondiendo al mensaje de ${replySenderName}: "${replyText}"]\n\n${text}`;
			await processConversation(
				ctx,
				content,
				userName,
				mentionType,
				botOff,
				isSleepingHour(),
			);
			return;
		}

		await processConversation(
			ctx,
			text,
			userName,
			mentionType,
			botOff,
			isSleepingHour(),
		);
	});
}
