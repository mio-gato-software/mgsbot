import { existsSync, mkdirSync } from "node:fs";

// --- Setup wizard check (before any bot imports that need env vars) ---

const forceSetup = process.argv.includes("--setup");
const needsSetup =
	forceSetup ||
	!existsSync("./.env") ||
	!process.env.BOT_TOKEN ||
	!process.env.GOOGLE_API_KEY ||
	!process.env.OWNER_USER_ID;

if (needsSetup) {
	const { runSetupWizard } = await import("./src/wizard.ts");
	await runSetupWizard();
	// Re-exec so Bun reloads .env from disk
	const args = process.argv.filter((a) => a !== "--setup");
	const proc = Bun.spawn(args, {
		stdio: ["inherit", "inherit", "inherit"],
	});
	await proc.exited;
	process.exit(proc.exitCode ?? 0);
}

// --- Bot imports (after env vars are confirmed present) ---

const { Bot } = await import("grammy");
const { flushEmbeddingCache } = await import("./src/embeddings.ts");
const { checkAndSendFollowUps, initFollowUps } = await import(
	"./src/follow-ups.ts"
);
const { isBotOff, isSleepingHour, registerHandlers } = await import(
	"./src/handlers.ts"
);
const { initIdentities } = await import("./src/identities.ts");
const { initMemoryDirs } = await import("./src/memory.ts");
const { initPersonality } = await import("./src/personality.ts");

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
