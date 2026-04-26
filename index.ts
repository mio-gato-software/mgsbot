import { existsSync, mkdirSync } from "node:fs";
import {
	formatProviderConfigurationFailure,
	formatProviderStartupSummary,
	validateProviderConfiguration,
} from "./src/provider-options.ts";
import { loadEnvIntoProcess } from "./src/utils.ts";

// --- Load .env manually (compiled binaries may not auto-load it) ---

loadEnvIntoProcess();

// --- Normalize env var aliases ---

if (!process.env.CHAT_PROVIDER && process.env.PROVIDER) {
	process.env.CHAT_PROVIDER = process.env.PROVIDER;
}

// --- Headless profile helpers (safe to run without bot env vars) ---

const showHelp = process.argv.includes("--help") || process.argv.includes("-h");
const initProfile = process.argv.includes("--init-profile");
const initRules = process.argv.includes("--init-rules");
const forceProfile = process.argv.includes("--force");
const showProfile = process.argv.includes("--show-profile");
const showRules = process.argv.includes("--show-rules");
const syncProfile = process.argv.includes("--sync-profile");

if (showHelp) {
	console.log(`MGS Bot

Usage:
  ./mgsbot                       Start the bot
  ./mgsbot --setup               Run the web setup wizard for .env
  ./mgsbot --init-profile        Create memory/bot_profile.json for manual personality setup
  ./mgsbot --init-profile --force  Overwrite memory/bot_profile.json with a fresh template
  ./mgsbot --show-profile        Print the active bot personality profile
  ./mgsbot --sync-profile        Copy memory/bot_profile.json into memory/bot_config.json
  ./mgsbot --init-rules          Create memory/bot_rules.json for editable behavior rules
  ./mgsbot --init-rules --force  Overwrite memory/bot_rules.json with a fresh template
  ./mgsbot --show-rules          Print custom behavior rules

Headless personality setup:
  1. Run ./mgsbot --init-profile
  2. Edit memory/bot_profile.json
  3. Run ./mgsbot

If memory/bot_profile.json exists and is valid, it is used as the active personality profile.`);
	process.exit(0);
}

if (initProfile || showProfile || syncProfile || initRules || showRules) {
	const {
		BOT_PROFILE_PATH,
		formatProfileStatus,
		syncManualProfileToConfig,
		writeProfileTemplate,
	} = await import("./src/config.ts");
	const { BOT_RULES_PATH, formatRulesStatus, writeRulesTemplate } =
		await import("./src/bot-rules.ts");

	if (initProfile) {
		const written = writeProfileTemplate(forceProfile);
		console.log(
			written
				? `Created ${BOT_PROFILE_PATH}. Edit it, then run ./mgsbot.`
				: `${BOT_PROFILE_PATH} already exists. Use --force to overwrite it.`,
		);
	}

	if (syncProfile) {
		const profile = syncManualProfileToConfig();
		console.log(
			profile
				? `Synced ${BOT_PROFILE_PATH} into memory/bot_config.json.`
				: `Could not sync ${BOT_PROFILE_PATH}; check that it exists and has required fields.`,
		);
	}

	if (showProfile) {
		console.log(formatProfileStatus());
	}

	if (initRules) {
		const written = writeRulesTemplate(forceProfile);
		console.log(
			written
				? `Created ${BOT_RULES_PATH}. Edit it, then run ./mgsbot.`
				: `${BOT_RULES_PATH} already exists. Use --force to overwrite it.`,
		);
	}

	if (showRules) {
		console.log(formatRulesStatus());
	}

	process.exit(0);
}

// --- Setup wizard check (before any bot imports that need env vars) ---

const forceSetup = process.argv.includes("--setup");
const needsSetup =
	forceSetup || !process.env.BOT_TOKEN || !process.env.GOOGLE_API_KEY;

if (needsSetup) {
	const { runSetupWizard } = await import("./src/wizard.ts");
	await runSetupWizard();
	loadEnvIntoProcess();
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
const { initMemoryDirs } = await import("./src/memory/index.ts");
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

const providerValidation = validateProviderConfiguration();
if (providerValidation.errors.length > 0) {
	console.error(formatProviderConfigurationFailure(providerValidation));
	process.exit(1);
}
for (const warning of providerValidation.warnings) {
	console.warn(`[startup] ${warning}`);
}
for (const line of formatProviderStartupSummary()) {
	console.log(line);
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

// Check-in proactive messages (only if enabled)
if (process.env.ENABLE_CHECK_INS === "true") {
	const { initCheckIns, checkAndSendCheckIns } = await import(
		"./src/check-ins.ts"
	);
	await initCheckIns();
	setInterval(() => {
		checkAndSendCheckIns(bot.api, isBotOff, isSleepingHour).catch(
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
