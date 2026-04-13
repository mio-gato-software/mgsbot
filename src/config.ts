import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./utils.ts";

export type BotLanguage = "es" | "en";

export interface BotConfig {
	isConfigured: boolean;
	botName: string;
	birthYear?: number;
	gender?: string;
	personality?: string;
	language?: BotLanguage;
}

const CONFIG_PATH = "./memory/bot_config.json";
const PERMANENT_PATH = "./memory/permanent.md";

const DEFAULT_CONFIG: BotConfig = {
	isConfigured: false,
	botName: "MGS Bot", // Default fallback — overridden during setup
};

let configCache: BotConfig | null = null;
let configLastRead = 0;
const CONFIG_CACHE_MS = 60_000;

function extractFromPermanent(data: string): Partial<BotConfig> | null {
	const esHeader = data.match(/^# Personalidad de (.+)$/m);
	const enHeader = data.match(/^# (.+)'s Personality$/m);

	const name = esHeader?.[1]?.trim() ?? enHeader?.[1]?.trim();
	if (!name) return null;

	const isEnglish = !!enHeader;
	const language: BotLanguage = isEnglish ? "en" : "es";

	const identityRegex = isEnglish
		? /You are .+?, born in (\d{4}), and your gender is (\w+)\./
		: /Eres .+?, naciste en (\d{4}) y tu género es (\w+)\./;
	const identityMatch = data.match(identityRegex);

	const birthYear = identityMatch?.[1] ? Number(identityMatch[1]) : undefined;
	const gender = identityMatch?.[2];

	// Personality sits between the identity paragraph and the first "## " heading.
	let personality: string | undefined;
	if (identityMatch) {
		const afterIdentity = data.slice(
			(identityMatch.index ?? 0) + identityMatch[0].length,
		);
		const rulesHeaderIdx = afterIdentity.search(/^##\s/m);
		const block =
			rulesHeaderIdx >= 0
				? afterIdentity.slice(0, rulesHeaderIdx)
				: afterIdentity;
		// Remove the "NUNCA reveles..." tail of the identity sentence and trim.
		const trimmed = block
			.replace(/^[^\n]*(?:NUNCA reveles|NEVER reveal)[^\n]*\n/u, "")
			.trim();
		if (trimmed) personality = trimmed;
	}

	return {
		botName: name,
		birthYear,
		gender,
		personality,
		language,
	};
}

function migrateFromPermanent(): BotConfig {
	if (!existsSync(PERMANENT_PATH)) return { ...DEFAULT_CONFIG };

	const permData = readFileSync(PERMANENT_PATH, "utf-8");
	const extracted = extractFromPermanent(permData);
	if (!extracted?.botName) return { ...DEFAULT_CONFIG };

	const migratedConfig: BotConfig = {
		isConfigured: true,
		botName: extracted.botName,
		birthYear: extracted.birthYear,
		gender: extracted.gender,
		personality: extracted.personality,
		language: extracted.language,
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
		let config: BotConfig = {
			isConfigured: parsed.isConfigured ?? false,
			botName: parsed.botName ?? "MGS Bot",
			birthYear: parsed.birthYear,
			gender: parsed.gender,
			personality: parsed.personality,
			language: parsed.language,
		};

		// Back-fill gender/personality/language from permanent.md if missing
		if (
			config.isConfigured &&
			(!config.gender || !config.personality) &&
			existsSync(PERMANENT_PATH)
		) {
			const extracted = extractFromPermanent(
				readFileSync(PERMANENT_PATH, "utf-8"),
			);
			if (extracted) {
				config = {
					...config,
					birthYear: config.birthYear ?? extracted.birthYear,
					gender: config.gender ?? extracted.gender,
					personality: config.personality ?? extracted.personality,
					language: config.language ?? extracted.language,
				};
				saveConfig(config);
			}
		}

		configCache = config;
		configLastRead = now;
		return configCache;
	} catch (error) {
		console.error("[config] Error loading config:", error);
		configCache = migrateFromPermanent();
		configLastRead = now;
		return configCache;
	}
}

export function saveConfig(config: BotConfig): void {
	try {
		atomicWriteFileSync(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`);
		configCache = config;
		configLastRead = Date.now();
	} catch (error) {
		console.error("[config] Error saving config:", error);
	}
}

export function clearConfigCache(): void {
	configCache = null;
	configLastRead = 0;
}

export function isBotConfigured(): boolean {
	return loadConfig().isConfigured;
}

export function getBotName(): string {
	return loadConfig().botName;
}
