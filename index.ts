import { Bot } from "grammy";
import { mkdir } from "node:fs/promises";
import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

const bot = new Bot(process.env.BOT_TOKEN!);
const ai = new GoogleGenAI({});

// Crear carpeta para guardar audios
await mkdir("./audios").catch(() => {});

// Transcribir audio usando Google GenAI
async function transcribeAudio(filePath: string, mimeType: string): Promise<string> {
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType },
  });
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: createUserContent([
      createPartFromUri(uploaded.uri!, uploaded.mimeType!),
      "Transcribe this audio exactly as spoken, in the original language",
    ]),
  });
  return response.text!;
}

// Guardar notas de voz
bot.on("message:voice", async (ctx) => {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = `./audios/voice_${ctx.message.message_id}.ogg`;
  await Bun.write(filePath, buffer);
  const transcription = await transcribeAudio(filePath, "audio/ogg");
  return ctx.reply(transcription);
});

// Guardar archivos de audio (mp3, etc.)
bot.on("message:audio", async (ctx) => {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = ctx.message.audio.mime_type?.split("/")[1] ?? "mp3";
  const mimeType = ctx.message.audio.mime_type ?? "audio/mp3";
  const filePath = `./audios/audio_${ctx.message.message_id}.${ext}`;
  await Bun.write(filePath, buffer);
  const transcription = await transcribeAudio(filePath, mimeType);
  return ctx.reply(transcription);
});

// Responder a otros mensajes
bot.on("message", (ctx) => {
  console.log(ctx.message);
  return ctx.reply("Hi there!");
});

bot.start();
