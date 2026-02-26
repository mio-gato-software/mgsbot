import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./utils.ts";

export type BotLanguage = "es" | "en";

export interface BotConfig {
	isConfigured: boolean;
	botName: string;
	birthYear?: number;
	language?: BotLanguage;
}

const CONFIG_PATH = "./memory/bot_config.json";
const PERMANENT_PATH = "./memory/permanent.md";

const DEFAULT_CONFIG: BotConfig = {
	isConfigured: false,
	botName: "Brendy", // Default fallback
};

// Cache config in memory (1-minute TTL, same pattern as loadPermanent)
let configCache: BotConfig | null = null;
let configLastRead = 0;
const CONFIG_CACHE_MS = 60_000;

function migrateFromPermanent(): BotConfig {
	if (!existsSync(PERMANENT_PATH)) return { ...DEFAULT_CONFIG };

	const permData = readFileSync(PERMANENT_PATH, "utf-8");
	// Only treat as configured if permanent.md has a real personality header (Spanish or English)
	const match =
		permData.match(/^# Personalidad de (.+)/im) ||
		permData.match(/^# (.+)'s Personality/im);
	if (!match?.[1]) return { ...DEFAULT_CONFIG };

	const migratedConfig: BotConfig = {
		isConfigured: true,
		botName: match[1].trim(),
	};

	saveConfig(migratedConfig);
	return migratedConfig;
}

export function loadConfig(): BotConfig {
	const now = Date.now();
	if (configCache && now - configLastRead < CONFIG_CACHE_MS) {
		return configCache;
	}

	try {
		if (!existsSync(CONFIG_PATH)) {
			configCache = migrateFromPermanent();
			configLastRead = now;
			return configCache;
		}
		const data = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(data);
		configCache = {
			isConfigured: parsed.isConfigured ?? false,
			botName: parsed.botName ?? "Brendy",
			birthYear: parsed.birthYear,
			language: parsed.language,
		};
		configLastRead = now;
		return configCache;
	} catch (error) {
		console.error("[config] Error loading config:", error);
		// Fallback: if bot_config.json is corrupted but permanent.md exists,
		// the bot is still configured — don't block all messages
		configCache = migrateFromPermanent();
		configLastRead = now;
		return configCache;
	}
}

export function saveConfig(config: BotConfig): void {
	try {
		atomicWriteFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
		// Update cache immediately after save
		configCache = config;
		configLastRead = Date.now();
	} catch (error) {
		console.error("[config] Error saving config:", error);
	}
}

export function isBotConfigured(): boolean {
	return loadConfig().isConfigured;
}

export function getBotName(): string {
	return loadConfig().botName;
}
