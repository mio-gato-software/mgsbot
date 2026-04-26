import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./utils.ts";

export interface BotRules {
	customInstructions?: string[];
	styleRules?: string[];
	relationshipRules?: string[];
	groupRules?: string[];
	newPersonRules?: string[];
}

export const BOT_RULES_PATH = "./memory/bot_rules.json";

const DEFAULT_RULES: Required<BotRules> = {
	customInstructions: [
		"Do not sound corporate or generic.",
		"If the user is emotional, respond to the emotion before giving advice.",
	],
	styleRules: [
		"Use a natural conversational tone.",
		"Keep most replies short unless the user clearly asks for detail.",
	],
	relationshipRules: [
		"Use remembered context subtly; do not force memories into unrelated topics.",
		"Prefer emotional continuity over reciting facts.",
	],
	groupRules: [
		"In groups, be briefer than in DMs.",
		"Do not derail group conversations.",
	],
	newPersonRules: ["Be welcoming without over-explaining yourself."],
};

function compactStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

export function parseBotRules(raw: unknown): BotRules {
	const parsed = raw as Partial<Record<keyof BotRules, unknown>> | null;
	if (!parsed || typeof parsed !== "object") return {};

	return {
		customInstructions: compactStringList(parsed.customInstructions),
		styleRules: compactStringList(parsed.styleRules),
		relationshipRules: compactStringList(parsed.relationshipRules),
		groupRules: compactStringList(parsed.groupRules),
		newPersonRules: compactStringList(parsed.newPersonRules),
	};
}

export function loadBotRules(): BotRules {
	if (!existsSync(BOT_RULES_PATH)) return {};
	try {
		const data = readFileSync(BOT_RULES_PATH, "utf-8");
		return parseBotRules(JSON.parse(data));
	} catch (error) {
		console.error(`[rules] Error loading ${BOT_RULES_PATH}:`, error);
		return {};
	}
}

export function writeRulesTemplate(overwrite = false): boolean {
	if (existsSync(BOT_RULES_PATH) && !overwrite) return false;
	atomicWriteFileSync(
		BOT_RULES_PATH,
		`${JSON.stringify(DEFAULT_RULES, null, "\t")}\n`,
	);
	return true;
}

function renderSection(title: string, rules: string[] | undefined): string[] {
	if (!rules?.length) return [];
	return [title, ...rules.map((rule) => `- ${rule}`), ""];
}

export function formatRulesStatus(): string {
	const rules = loadBotRules();
	const parts = [
		`Rules source: ${existsSync(BOT_RULES_PATH) ? BOT_RULES_PATH : "(none)"}`,
		"",
		...renderSection("Custom instructions:", rules.customInstructions),
		...renderSection("Style rules:", rules.styleRules),
		...renderSection("Relationship rules:", rules.relationshipRules),
		...renderSection("Group rules:", rules.groupRules),
		...renderSection("New person rules:", rules.newPersonRules),
	];

	const rendered = parts.join("\n").trim();
	return rendered || `Rules source: (none)\n\nNo custom bot rules configured.`;
}
