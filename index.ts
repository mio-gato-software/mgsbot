import { Bot } from "grammy";
import { mkdir } from "node:fs/promises";
import { initMemoryDirs } from "./src/memory.ts";
import { registerHandlers } from "./src/handlers.ts";

const bot = new Bot(process.env.BOT_TOKEN!);

// Initialize directories
await mkdir("./audios").catch(() => {});
await initMemoryDirs();

// Register all message handlers
registerHandlers(bot);

bot.start();
