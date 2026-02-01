import { mkdir } from "node:fs/promises";
import { Bot } from "grammy";
import { registerHandlers } from "./src/handlers.ts";
import { initMemoryDirs } from "./src/memory.ts";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN environment variable is required");
const bot = new Bot(token);

// Initialize directories
await mkdir("./audios").catch(() => {});
await initMemoryDirs();

// Register all message handlers
registerHandlers(bot);

bot.start();

if (process.env.NODE_ENV === "development") {
	console.log(`[startup] Bot started (NODE_ENV=development)`);
}
