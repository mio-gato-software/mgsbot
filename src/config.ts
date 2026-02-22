import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface BotConfig {
	isConfigured: boolean;
	botName: string;
}

const CONFIG_PATH = "./memory/bot_config.json";
const PERMANENT_PATH = "./memory/permanent.md";

const DEFAULT_CONFIG: BotConfig = {
	isConfigured: false,
	botName: "Brendy", // Default fallback
};

export function loadConfig(): BotConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			// Migration for existing bots: if permanent.md exists, assume it is already configured
			if (existsSync(PERMANENT_PATH)) {
				const permData = readFileSync(PERMANENT_PATH, "utf-8");
				const match = permData.match(/^# Personalidad de (.+)/im);
				let botName = "Brendy";
				if (match?.[1]) {
					botName = match[1].trim();
				}

				const migratedConfig: BotConfig = {
					isConfigured: true,
					botName: botName,
				};

				saveConfig(migratedConfig);
				return migratedConfig;
			}
			return { ...DEFAULT_CONFIG };
		}
		const data = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(data);
		return {
			isConfigured: parsed.isConfigured ?? false,
			botName: parsed.botName ?? "Brendy",
		};
	} catch (error) {
		console.error("[config] Error loading config:", error);
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: BotConfig): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
