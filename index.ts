import { mkdir } from "node:fs/promises";
import { Bot } from "grammy";
import { checkAndSendFollowUps, initFollowUps } from "./src/follow-ups.ts";
import { isBotOff, isSleepingHour, registerHandlers } from "./src/handlers.ts";
import { initIdentities } from "./src/identities.ts";
import { initMemoryDirs } from "./src/memory.ts";
import { initPersonality } from "./src/personality.ts";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN environment variable is required");
const bot = new Bot(token);

// Initialize directories
await mkdir("./audios").catch(() => {});
await initMemoryDirs();
await initIdentities();
await initFollowUps();
await initPersonality();

// Register all message handlers
registerHandlers(bot);

bot.catch((err) => {
	console.error("[bot.catch] Error in middleware:", err.message);
});

bot.start();

// Follow-up checker (only if enabled)
if (process.env.ENABLE_FOLLOW_UPS === "true") {
	setInterval(() => {
		checkAndSendFollowUps(bot.api, isBotOff, isSleepingHour).catch(
			console.error,
		);
	}, 60_000);
}

if (process.env.NODE_ENV === "development") {
	console.log(`[startup] Bot started (NODE_ENV=development)`);
}
