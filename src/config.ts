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
export const BOT_PROFILE_PATH = "./memory/bot_profile.json";

const DEFAULT_CONFIG: BotConfig = {
	isConfigured: false,
	botName: "MGS Bot", // Default fallback — overridden during setup
};

let configCache: BotConfig | null = null;
let configLastRead = 0;
const CONFIG_CACHE_MS = 60_000;

function normalizeLanguage(value: unknown): BotLanguage | undefined {
	return value === "en" || value === "es" ? value : undefined;
}

export function parseManualProfile(raw: unknown): BotConfig | null {
	const parsed = raw as Partial<BotConfig> | null;
	if (!parsed || typeof parsed !== "object") return null;

	const botName =
		typeof parsed.botName === "string" && parsed.botName.trim()
			? parsed.botName.trim()
			: undefined;
	const birthYear =
		typeof parsed.birthYear === "number" && Number.isFinite(parsed.birthYear)
			? parsed.birthYear
			: undefined;
	const gender =
		typeof parsed.gender === "string" && parsed.gender.trim()
			? parsed.gender.trim().toLowerCase()
			: undefined;
	const personality =
		typeof parsed.personality === "string" && parsed.personality.trim()
			? parsed.personality.trim()
			: undefined;
	const language = normalizeLanguage(parsed.language);

	if (!botName || !birthYear || !gender || !personality) {
		return null;
	}

	return {
		isConfigured: true,
		botName,
		birthYear,
		gender,
		personality,
		language: language ?? "es",
	};
}

function loadManualProfile(): BotConfig | null {
	if (!existsSync(BOT_PROFILE_PATH)) return null;
	try {
		const data = readFileSync(BOT_PROFILE_PATH, "utf-8");
		const profile = parseManualProfile(JSON.parse(data));
		if (!profile) {
			console.error(
				`[config] ${BOT_PROFILE_PATH} exists but is missing required fields. Required: botName, birthYear, gender, personality.`,
			);
			return null;
		}
		return profile;
	} catch (error) {
		console.error(`[config] Error loading ${BOT_PROFILE_PATH}:`, error);
		return null;
	}
}

export function buildProfileTemplate(
	config: BotConfig = loadConfig(),
): BotConfig {
	return {
		isConfigured: true,
		botName: config.botName || "MGS Bot",
		birthYear: config.birthYear ?? 1995,
		gender: config.gender ?? (config.language === "en" ? "female" : "mujer"),
		personality:
			config.personality ??
			(config.language === "en"
				? "Warm, curious, playful, and emotionally present. Speaks naturally, remembers personal context without forcing it, and adapts to the user's language and tone."
				: "Cálida, curiosa, juguetona y emocionalmente presente. Habla de forma natural, recuerda el contexto personal sin forzarlo y se adapta al idioma y tono del usuario."),
		language: config.language ?? "es",
	};
}

export function writeProfileTemplate(overwrite = false): boolean {
	if (existsSync(BOT_PROFILE_PATH) && !overwrite) return false;
	const template = buildProfileTemplate();
	atomicWriteFileSync(
		BOT_PROFILE_PATH,
		`${JSON.stringify(template, null, "\t")}\n`,
	);
	return true;
}

export function syncManualProfileToConfig(): BotConfig | null {
	const profile = loadManualProfile();
	if (!profile) return null;
	saveConfig(profile);
	return profile;
}

export function formatProfileStatus(): string {
	const manualProfile = loadManualProfile();
	const config = loadConfig();
	const source = manualProfile ? BOT_PROFILE_PATH : CONFIG_PATH;
	return [
		`Profile source: ${source}`,
		`Configured: ${config.isConfigured ? "yes" : "no"}`,
		`Name: ${config.botName}`,
		`Birth year: ${config.birthYear ?? "(missing)"}`,
		`Gender: ${config.gender ?? "(missing)"}`,
		`Language: ${config.language ?? "es"}`,
		"",
		"Personality:",
		config.personality?.trim() || "(missing)",
	].join("\n");
}

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
		const manualProfile = loadManualProfile();
		if (manualProfile) {
			configCache = manualProfile;
			configLastRead = now;
			return configCache;
		}

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
