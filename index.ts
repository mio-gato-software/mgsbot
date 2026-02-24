import { existsSync, mkdirSync } from "node:fs";
import { Bot } from "grammy";
import { flushEmbeddingCache } from "./src/embeddings.ts";
import { checkAndSendFollowUps, initFollowUps } from "./src/follow-ups.ts";
import { isBotOff, isSleepingHour, registerHandlers } from "./src/handlers.ts";
import { initIdentities } from "./src/identities.ts";
import { initMemoryDirs } from "./src/memory.ts";
import { initPersonality } from "./src/personality.ts";

// --- Startup env validation ---

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN environment variable is required");

if (!process.env.GOOGLE_API_KEY) {
	throw new Error("GOOGLE_API_KEY environment variable is required");
}

if (!process.env.ALLOWED_GROUP_ID) {
	console.warn(
		"[startup] ALLOWED_GROUP_ID not set — bot will ignore all group chats",
	);
}
if (!process.env.OWNER_USER_ID) {
	console.warn("[startup] OWNER_USER_ID not set — bot will ignore all DMs");
}

if (!process.env.LEMON_FOX_API_KEY) {
	console.warn("[startup] LEMON_FOX_API_KEY not set — TTS will be unavailable");
}

const bot = new Bot(token);

// Initialize directories
if (!existsSync("./audios")) mkdirSync("./audios", { recursive: true });
await initMemoryDirs();
await initIdentities();
await initFollowUps();
await initPersonality();

// Register all message handlers
registerHandlers(bot);

bot.catch((err) => {
	console.error("[bot.catch] Error in middleware:", err.error);
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

// --- Graceful shutdown ---

async function shutdown(signal: string): Promise<void> {
	console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
	bot.stop();
	await flushEmbeddingCache();
	console.log("[shutdown] Embedding cache flushed. Goodbye.");
	process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (process.env.NODE_ENV === "development") {
	console.log("[startup] Bot started (NODE_ENV=development)");
}
