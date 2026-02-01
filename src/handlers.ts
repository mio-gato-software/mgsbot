import type { Bot, Context } from "grammy";
import { transcribeAudio, generateResponse, evaluateMemory } from "./ai.ts";
import {
  loadShortTerm,
  addMessageToShortTerm,
  loadLongTerm,
  saveLongTerm,
  getRelevantMemories,
  addLongTermMemories,
} from "./memory.ts";
import { buildSystemPrompt, buildContents } from "./prompt.ts";
import type { ConversationMessage } from "./types.ts";

const SILENCE_TOKEN = "[SILENCE]";
const EVAL_EVERY_N_MESSAGES = 5;

function getUserDisplayName(ctx: Context): string {
  const user = ctx.from;
  if (!user) return "Unknown";
  if (user.first_name && user.last_name)
    return `${user.first_name} ${user.last_name}`;
  return user.first_name ?? user.username ?? "Unknown";
}

function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === "group" || type === "supergroup";
}

function isBotMentionedOrRepliedTo(ctx: Context, botId: number): boolean {
  // Check if replied to the bot
  if (ctx.message?.reply_to_message?.from?.id === botId) return true;

  // Check if bot is mentioned in entities
  const entities = ctx.message?.entities ?? [];
  const text = ctx.message?.text ?? "";
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mention = text.slice(entity.offset, entity.offset + entity.length);
      if (mention === `@${ctx.me?.username}`) return true;
    }
  }

  return false;
}

async function processConversation(
  ctx: Context,
  userContent: string,
  userName: string,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const botInfo = ctx.me;

  // Load memories
  const shortTerm = await loadShortTerm(chatId);
  const longTermEntries = await loadLongTerm();
  const relevantMemories = getRelevantMemories(longTermEntries);

  // Save updated lastAccessed times
  if (relevantMemories.length > 0) {
    await saveLongTerm(longTermEntries);
  }

  // Add user message to short-term
  const userMessage: ConversationMessage = {
    role: "user",
    name: userName,
    content: userContent,
    timestamp: Date.now(),
  };
  await addMessageToShortTerm(shortTerm, userMessage);

  // Build prompt
  const systemPrompt = await buildSystemPrompt(
    relevantMemories,
    shortTerm.previousSummary,
  );
  const contents = buildContents(shortTerm);

  // In groups, add instruction for selective response
  let effectiveSystemPrompt = systemPrompt;
  if (isGroupChat(ctx) && !isBotMentionedOrRepliedTo(ctx, botInfo.id)) {
    effectiveSystemPrompt += `\n\n## Group response rule\nThis is a group chat and you were NOT directly mentioned or replied to. Only respond if you have something genuinely relevant or useful to contribute. If you have nothing meaningful to add, respond with exactly: ${SILENCE_TOKEN}`;
  }

  // Generate response
  const responseText = await generateResponse(effectiveSystemPrompt, contents);

  // Check for silence
  if (responseText.trim() === SILENCE_TOKEN) {
    return;
  }

  // Save bot response to short-term
  const botMessage: ConversationMessage = {
    role: "model",
    content: responseText,
    timestamp: Date.now(),
  };
  await addMessageToShortTerm(shortTerm, botMessage);

  // Reply
  await ctx.reply(responseText, {
    reply_to_message_id: isGroupChat(ctx)
      ? ctx.message?.message_id
      : undefined,
  });

  // Trigger long-term memory evaluation every N messages
  if (shortTerm.messageCountSinceEval >= EVAL_EVERY_N_MESSAGES) {
    shortTerm.messageCountSinceEval = 0;
    // Run evaluation in background (don't await)
    triggerMemoryEvaluation(shortTerm.messages).catch(console.error);
  }
}

async function triggerMemoryEvaluation(
  messages: ConversationMessage[],
): Promise<void> {
  const recentText = messages
    .slice(-10)
    .map(
      (m) =>
        `${m.role === "user" ? m.name ?? "User" : "Bot"}: ${m.content}`,
    )
    .join("\n");

  const evaluation = await evaluateMemory(recentText);

  if (evaluation.save && evaluation.memories.length > 0) {
    await addLongTermMemories(evaluation.memories);
  }
}

async function downloadAndTranscribe(
  ctx: Context,
  mimeType: string,
  fileExtension: string,
  prefix: string,
): Promise<string> {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${ctx.api.config.use().token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = `./audios/${prefix}_${ctx.message!.message_id}.${fileExtension}`;
  await Bun.write(filePath, buffer);
  return transcribeAudio(filePath, mimeType);
}

export function registerHandlers(bot: Bot): void {
  // Voice messages
  bot.on("message:voice", async (ctx) => {
    const transcription = await downloadAndTranscribe(
      ctx,
      "audio/ogg",
      "ogg",
      "voice",
    );
    const userName = getUserDisplayName(ctx);
    const content = `[Audio from ${userName}]: ${transcription}`;
    await processConversation(ctx, content, userName);
  });

  // Audio files
  bot.on("message:audio", async (ctx) => {
    const ext = ctx.message.audio.mime_type?.split("/")[1] ?? "mp3";
    const mimeType = ctx.message.audio.mime_type ?? "audio/mp3";
    const transcription = await downloadAndTranscribe(ctx, mimeType, ext, "audio");
    const userName = getUserDisplayName(ctx);
    const content = `[Audio from ${userName}]: ${transcription}`;
    await processConversation(ctx, content, userName);
  });

  // Text messages (catch-all)
  bot.on("message", async (ctx) => {
    const text = ctx.message.text;
    if (!text) return;
    const userName = getUserDisplayName(ctx);
    await processConversation(ctx, text, userName);
  });
}
