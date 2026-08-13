import { existsSync, mkdirSync } from "node:fs";
import { alertOwner, errorSummary, setAlertSink } from "./src/alerts.ts";
import { log } from "./src/logger.ts";
import {
	findEnvCaseMismatches,
	formatProviderConfigurationFailure,
	formatProviderStartupSummary,
	validateProviderConfiguration,
} from "./src/provider-options.ts";
import { loadEnvIntoProcess, parseEnvFile } from "./src/utils.ts";

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
	forceSetup ||
	!process.env.BOT_TOKEN ||
	(!process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY);

if (needsSetup) {
	const { runSetupWizard } = await import("./src/wizard.ts");
	await runSetupWizard();
	loadEnvIntoProcess();
}

// --- Bot imports (after env vars are confirmed present) ---

const { unlink } = await import("node:fs/promises");
const { Bot } = await import("grammy");
const { flushEmbeddingCache } = await import("./src/embeddings.ts");
const { runMemoryBackup } = await import("./src/memory-backup.ts");
const { checkAndSendFollowUps, initFollowUps } = await import(
	"./src/follow-ups.ts"
);
const { isBotOff, isSleepingHour, registerHandlers } = await import(
	"./src/handlers.ts"
);
const { retrySpooledPromotions } = await import("./src/conversation.ts");
const { runSemanticJanitor } = await import("./src/janitor.ts");
const { initIdentities } = await import("./src/identities.ts");
const { initMemoryDirs, runExtractionHealthCheck } = await import(
	"./src/memory/index.ts"
);
const { initPersonality } = await import("./src/personality.ts");

// --- Startup env validation ---

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN environment variable is required");

if (!process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY) {
	throw new Error(
		"Set OPENAI_API_KEY or GOOGLE_API_KEY. OpenAI alone is enough for most features.",
	);
}

if (!process.env.ALLOWED_GROUP_ID) {
	log.warn(
		"[startup] ALLOWED_GROUP_ID not set — bot will ignore all group chats",
	);
}
if (!process.env.OWNER_USER_ID) {
	log.warn("[startup] OWNER_USER_ID not set — bot will ignore all DMs");
}

const providerValidation = validateProviderConfiguration();
if (providerValidation.errors.length > 0) {
	log.error(formatProviderConfigurationFailure(providerValidation));
	process.exit(1);
}
for (const warning of providerValidation.warnings) {
	log.warn(`[startup] ${warning}`);
}
for (const warning of findEnvCaseMismatches(Object.keys(parseEnvFile()))) {
	log.warn(`[startup] ${warning}`);
}
for (const line of formatProviderStartupSummary()) {
	log.info(line);
}

const bot = new Bot(token);

// Owner alert delivery: plain-text DM to OWNER_USER_ID (no-op if unset)
const ownerUserId = process.env.OWNER_USER_ID;
if (ownerUserId) {
	setAlertSink(async (text) => {
		try {
			await bot.api.sendMessage(ownerUserId, text);
		} catch (err) {
			log.error("[alerts] Failed to send owner alert:", err);
		}
	});
}

// Initialize directories
if (!existsSync("./audios")) mkdirSync("./audios", { recursive: true });
await initMemoryDirs();
await initIdentities();
await initFollowUps();
await initPersonality();

// Register all message handlers
registerHandlers(bot);

bot.catch((err) => {
	log.error("[bot.catch] Error in middleware:", err.error);
	alertOwner("bot-middleware", `Middleware error: ${errorSummary(err.error)}`);
});

bot.start();

const intervals: ReturnType<typeof setInterval>[] = [];

// Liveness heartbeat for container healthchecks (see docker-compose.yml)
const HEARTBEAT_FILE = "/tmp/mgsbot-heartbeat";
intervals.push(
	setInterval(() => {
		Bun.write(HEARTBEAT_FILE, String(Date.now())).catch((err) => {
			log.debug("[heartbeat] Failed to write heartbeat:", err);
		});
	}, 30_000),
);

// Daily memory snapshot (runs at startup, then re-checks hourly for rollover)
runMemoryBackup().catch((err) => {
	log.error("[backup] Memory backup failed:", err);
});
intervals.push(
	setInterval(() => {
		runMemoryBackup().catch((err) => {
			log.error("[backup] Memory backup failed:", err);
		});
	}, 3_600_000),
);

// Retry promotions that failed or were captured by the inactivity wipe
// (runs at startup, then hourly)
retrySpooledPromotions().catch((err) => {
	log.error("[spool] Startup promotion retry failed:", err);
});
intervals.push(
	setInterval(() => {
		retrySpooledPromotions().catch((err) => {
			log.error("[spool] Promotion retry failed:", err);
		});
	}, 3_600_000),
);

// Extraction-quality watch: rolling 7-day report on how the cheap background
// model is extracting, with an owner alert when it degrades (checked hourly,
// runs at most once per day)
runExtractionHealthCheck(alertOwner).catch((err) => {
	log.debug("[promote-metrics] Startup health check failed:", err);
});
intervals.push(
	setInterval(() => {
		runExtractionHealthCheck(alertOwner).catch((err) => {
			log.debug("[promote-metrics] Health check failed:", err);
		});
	}, 3_600_000),
);

// Semantic janitor: reviews same-subject fact clusters for contradictions
// and duplicates (checked hourly, runs at most once per day)
if (process.env.ENABLE_MEMORY_JANITOR !== "false") {
	intervals.push(
		setInterval(() => {
			runSemanticJanitor().catch((err) => {
				log.error("[janitor] Semantic janitor failed:", err);
			});
		}, 3_600_000),
	);
}

// Follow-up checker (only if enabled)
if (process.env.ENABLE_FOLLOW_UPS === "true") {
	intervals.push(
		setInterval(() => {
			checkAndSendFollowUps(bot.api, isBotOff, isSleepingHour).catch(log.error);
		}, 60_000),
	);
}

// Check-in proactive messages (only if enabled)
if (process.env.ENABLE_CHECK_INS === "true") {
	const { initCheckIns, checkAndSendCheckIns } = await import(
		"./src/check-ins.ts"
	);
	await initCheckIns();
	intervals.push(
		setInterval(() => {
			checkAndSendCheckIns(bot.api, isBotOff, isSleepingHour).catch(log.error);
		}, 60_000),
	);
}

// --- Graceful shutdown ---

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info(`[shutdown] Received ${signal}, shutting down gracefully...`);

	// Watchdog: if any step below hangs, force-exit instead of waiting for
	// the supervisor's SIGKILL.
	const watchdog = setTimeout(() => {
		log.error("[shutdown] Timed out, forcing exit");
		process.exit(1);
	}, SHUTDOWN_TIMEOUT_MS);

	for (const interval of intervals) clearInterval(interval);

	try {
		await bot.stop();
		await flushEmbeddingCache();
		await unlink(HEARTBEAT_FILE).catch(() => {});
		log.info("[shutdown] Embedding cache flushed. Goodbye.");
		clearTimeout(watchdog);
		process.exit(0);
	} catch (err) {
		log.error("[shutdown] Error during shutdown:", err);
		process.exit(1);
	}
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (process.env.NODE_ENV === "development") {
	log.debug("[startup] Bot started (NODE_ENV=development)");
}
