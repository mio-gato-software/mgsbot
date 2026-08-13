import { z } from "zod";
import {
	DEFAULT_GEMINI_CHAT_MODEL,
	DEFAULT_OPENAI_CHAT_MODEL,
	DEFAULT_OPENAI_IMAGE_MODEL,
	resolveAiPlatform,
	resolveBackgroundProvider,
	resolveDefaultChatProviderName,
	resolveDefaultImageProviderName,
	resolveEmbeddingProvider,
} from "./ai/platform.ts";

type EnvMap = NodeJS.ProcessEnv;

interface ProviderOption<Name extends string> {
	name: Name;
	label: string;
	requiredEnv: readonly string[];
	modelEnv?: string;
	defaultModel?: string;
	description: string;
}

export const CHAT_PROVIDERS = [
	{
		name: "gemini",
		label: "Gemini",
		requiredEnv: ["GOOGLE_API_KEY"],
		modelEnv: "GEMINI_MODEL",
		defaultModel: DEFAULT_GEMINI_CHAT_MODEL,
		description: "Main Google chat provider with native inline image support.",
	},
	{
		name: "openrouter",
		label: "OpenRouter",
		requiredEnv: ["OPENROUTER_API_KEY"],
		modelEnv: "OPENROUTER_MODEL",
		defaultModel: "anthropic/claude-3.5-sonnet",
		description: "Chat through OpenRouter; media falls back to Google paths.",
	},
	{
		name: "anthropic",
		label: "Anthropic",
		requiredEnv: ["ANTHROPIC_API_KEY"],
		modelEnv: "ANTHROPIC_MODEL",
		defaultModel: "claude-sonnet-4-5-20250929",
		description: "Chat through Anthropic; media falls back to Google paths.",
	},
	{
		name: "azure",
		label: "Azure OpenAI",
		requiredEnv: ["AZURE_API_KEY", "AZURE_ENDPOINT"],
		modelEnv: "AZURE_MODEL",
		defaultModel: "Kimi-K2.5",
		description: "Chat through an Azure OpenAI-compatible deployment.",
	},
	{
		name: "alibaba",
		label: "Alibaba DashScope",
		requiredEnv: ["DASHSCOPE_API_KEY"],
		modelEnv: "DASHSCOPE_MODEL",
		defaultModel: "qwen3.5-plus",
		description: "Chat through Alibaba DashScope.",
	},
	{
		name: "fireworks",
		label: "Fireworks AI",
		requiredEnv: ["FIREWORKS_API_KEY"],
		modelEnv: "FIREWORKS_MODEL",
		defaultModel: "accounts/fireworks/models/glm-5",
		description: "Chat through Fireworks AI.",
	},
	{
		name: "openai",
		label: "OpenAI",
		requiredEnv: ["OPENAI_API_KEY"],
		modelEnv: "OPENAI_MODEL",
		defaultModel: DEFAULT_OPENAI_CHAT_MODEL,
		description:
			"Chat through OpenAI (default gpt-5.6-luna). With only OPENAI_API_KEY, the same key can also cover embeddings, STT, TTS, images, PDFs, and background work.",
	},
	{
		name: "deepseek",
		label: "DeepSeek",
		requiredEnv: ["DEEPSEEK_API_KEY"],
		modelEnv: "DEEPSEEK_MODEL",
		defaultModel: "deepseek-v4-pro",
		description:
			"Chat through DeepSeek's OpenAI-compatible chat completions API.",
	},
	{
		name: "fal",
		label: "fal.ai",
		requiredEnv: ["FAL_API_KEY"],
		modelEnv: "FAL_MODEL",
		defaultModel: "google/gemini-2.5-pro",
		description: "Chat through fal.ai's OpenRouter proxy.",
	},
] as const satisfies readonly ProviderOption<string>[];

export const TTS_PROVIDERS = [
	{
		name: "elevenlabs",
		label: "ElevenLabs",
		requiredEnv: ["ELEVENLABS_API_KEY"],
		description: "Auto-selected first when ELEVENLABS_API_KEY is set.",
	},
	{
		name: "inworld",
		label: "Inworld",
		requiredEnv: ["INWORLD_API_KEY", "INWORLD_VOICE_ID"],
		description:
			"Auto-selected after ElevenLabs when both Inworld env vars are set.",
	},
	{
		name: "lemonfox",
		label: "LemonFox",
		requiredEnv: ["LEMON_FOX_API_KEY"],
		description:
			"Auto-selected after ElevenLabs/Inworld when LEMON_FOX_API_KEY is set.",
	},
	{
		name: "fal",
		label: "fal.ai",
		requiredEnv: ["FAL_API_KEY"],
		description: "Available only when TTS_PROVIDER=fal is set explicitly.",
	},
	{
		name: "openai",
		label: "OpenAI",
		requiredEnv: ["OPENAI_API_KEY"],
		modelEnv: "OPENAI_TTS_MODEL",
		defaultModel: "gpt-4o-mini-tts",
		description: "Auto-selected last when OPENAI_API_KEY is set.",
	},
] as const satisfies readonly ProviderOption<string>[];

export const STT_PROVIDERS = [
	{
		name: "gemini",
		label: "Gemini",
		requiredEnv: ["GOOGLE_API_KEY"],
		description: "Default transcription provider when GOOGLE_API_KEY is set.",
	},
	{
		name: "fal",
		label: "fal.ai",
		requiredEnv: ["FAL_API_KEY"],
		description: "Second automatic fallback when FAL_API_KEY is set.",
	},
	{
		name: "lemonfox",
		label: "LemonFox",
		requiredEnv: ["LEMON_FOX_API_KEY"],
		description: "Automatic fallback when LEMON_FOX_API_KEY is set.",
	},
	{
		name: "openai",
		label: "OpenAI",
		requiredEnv: ["OPENAI_API_KEY"],
		modelEnv: "OPENAI_STT_MODEL",
		defaultModel: "gpt-4o-mini-transcribe",
		description: "OpenAI transcription when OPENAI_API_KEY is set.",
	},
] as const satisfies readonly ProviderOption<string>[];

export const IMAGE_PROVIDERS = [
	{
		name: "gemini",
		label: "Gemini",
		requiredEnv: ["GOOGLE_API_KEY"],
		description: "Default character image generation and editing provider.",
	},
	{
		name: "fal",
		label: "fal.ai",
		requiredEnv: ["FAL_API_KEY"],
		modelEnv: "FAL_IMAGE_MODEL",
		defaultModel: "nano-banana-pro",
		description: "Alternative image provider using Nano Banana Pro by default.",
	},
	{
		name: "openai",
		label: "OpenAI",
		requiredEnv: ["OPENAI_API_KEY"],
		modelEnv: "OPENAI_IMAGE_MODEL",
		defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
		description: "OpenAI Images API (gpt-image-2 by default).",
	},
] as const satisfies readonly ProviderOption<string>[];

export const FAL_IMAGE_MODELS = [
	{
		name: "gpt-image-2",
		label: "GPT Image 2",
		textEndpoint: "openai/gpt-image-2",
		editEndpoint: "openai/gpt-image-2/edit",
	},
	{
		name: "nano-banana-pro",
		label: "Nano Banana Pro",
		textEndpoint: "fal-ai/nano-banana-pro",
		editEndpoint: "fal-ai/nano-banana-pro/edit",
	},
] as const;

export const FAL_IMAGE_QUALITIES = ["low", "medium", "high"] as const;

export type ChatProviderName = (typeof CHAT_PROVIDERS)[number]["name"];
export type TtsProviderName = (typeof TTS_PROVIDERS)[number]["name"];
export type SttProviderName = (typeof STT_PROVIDERS)[number]["name"];
export type ImageProviderName = (typeof IMAGE_PROVIDERS)[number]["name"];
export type FalImageModelName = (typeof FAL_IMAGE_MODELS)[number]["name"];
export type FalImageQuality = (typeof FAL_IMAGE_QUALITIES)[number];

interface ProviderEnv extends EnvMap {
	CHAT_PROVIDER?: ChatProviderName;
	STT_PROVIDER?: SttProviderName;
	TTS_PROVIDER?: TtsProviderName;
	IMAGE_PROVIDER?: ImageProviderName;
	AI_PLATFORM?: "gemini" | "openai";
	EMBEDDING_PROVIDER?: "gemini" | "openai";
	VISION_PROVIDER?: "gemini" | "openai";
	DOCUMENT_PROVIDER?: "gemini" | "openai";
	BACKGROUND_PROVIDER?: "gemini" | "openai";
	CLASSIFIER_PROVIDER?: "gemini" | "openai";
	YOUTUBE_PROVIDER?: "gemini" | "openai";
	OPENROUTER_TRANSPORT?: OpenRouterTransport;
	FAL_IMAGE_MODEL?: string;
	FAL_IMAGE_QUALITY?: string;
}

export const CHAT_PROVIDER_NAMES = CHAT_PROVIDERS.map(
	(provider) => provider.name,
);
export const TTS_PROVIDER_NAMES = TTS_PROVIDERS.map(
	(provider) => provider.name,
);
export const STT_PROVIDER_NAMES = STT_PROVIDERS.map(
	(provider) => provider.name,
);
export const IMAGE_PROVIDER_NAMES = IMAGE_PROVIDERS.map(
	(provider) => provider.name,
);

export const OPENROUTER_TRANSPORTS = ["direct", "fal"] as const;
export type OpenRouterTransport = (typeof OPENROUTER_TRANSPORTS)[number];

const blankToUndefined = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
};

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalProviderString = (schema: z.ZodEnum) =>
	z.preprocess((value) => {
		const normalized = blankToUndefined(value);
		return typeof normalized === "string"
			? normalized.toLowerCase()
			: normalized;
	}, schema.optional());

const ProviderEnvSchema = z.object({
	CHAT_PROVIDER: optionalProviderString(
		z.enum([
			"gemini",
			"openrouter",
			"anthropic",
			"azure",
			"alibaba",
			"fireworks",
			"openai",
			"deepseek",
			"fal",
		]),
	),
	STT_PROVIDER: optionalProviderString(
		z.enum(["gemini", "fal", "lemonfox", "openai"]),
	),
	TTS_PROVIDER: optionalProviderString(
		z.enum(["elevenlabs", "inworld", "lemonfox", "fal", "openai"]),
	),
	IMAGE_PROVIDER: optionalProviderString(z.enum(["gemini", "fal", "openai"])),
	AI_PLATFORM: optionalProviderString(z.enum(["gemini", "openai"])),
	EMBEDDING_PROVIDER: optionalProviderString(z.enum(["gemini", "openai"])),
	VISION_PROVIDER: optionalProviderString(z.enum(["gemini", "openai"])),
	DOCUMENT_PROVIDER: optionalProviderString(z.enum(["gemini", "openai"])),
	BACKGROUND_PROVIDER: optionalProviderString(z.enum(["gemini", "openai"])),
	CLASSIFIER_PROVIDER: optionalProviderString(z.enum(["gemini", "openai"])),
	YOUTUBE_PROVIDER: optionalProviderString(z.enum(["gemini", "openai"])),
	OPENROUTER_TRANSPORT: optionalProviderString(z.enum(["direct", "fal"])),
	FAL_IMAGE_MODEL: optionalString,
	FAL_IMAGE_QUALITY: optionalString,
	GOOGLE_API_KEY: optionalString,
	OPENROUTER_API_KEY: optionalString,
	ANTHROPIC_API_KEY: optionalString,
	AZURE_API_KEY: optionalString,
	AZURE_ENDPOINT: optionalString,
	DASHSCOPE_API_KEY: optionalString,
	FIREWORKS_API_KEY: optionalString,
	OPENAI_API_KEY: optionalString,
	DEEPSEEK_API_KEY: optionalString,
	FAL_API_KEY: optionalString,
	ELEVENLABS_API_KEY: optionalString,
	LEMON_FOX_API_KEY: optionalString,
	INWORLD_API_KEY: optionalString,
	INWORLD_VOICE_ID: optionalString,
});

// Vars read directly via process.env elsewhere in the codebase (not part of
// the provider schema) — included so case typos on them get flagged too.
const CORE_ENV_VARS = [
	"BOT_TOKEN",
	"OWNER_USER_ID",
	"ALLOWED_GROUP_ID",
	"BOT_TIMEZONE",
	"PROVIDER",
	"AI_PLATFORM",
	"GEMINI_MODEL",
	"GEMINI_VISION_MODEL",
	"GEMINI_DOCUMENT_MODEL",
	"GEMINI_STT_MODEL",
	"GEMINI_IMAGE_MODEL",
	"GEMINI_IMAGE_SIZE",
	"BACKGROUND_MODEL",
	"BACKGROUND_PROVIDER",
	"CLASSIFIER_MODEL",
	"CLASSIFIER_PROVIDER",
	"EMBEDDING_PROVIDER",
	"EMBEDDING_MODEL",
	"EMBEDDING_DIM",
	"AUTO_REEMBED",
	"VISION_PROVIDER",
	"DOCUMENT_PROVIDER",
	"YOUTUBE_PROVIDER",
	"OPENAI_MODEL",
	"OPENAI_VISION_MODEL",
	"OPENAI_DOCUMENT_MODEL",
	"OPENAI_STT_MODEL",
	"OPENAI_TTS_MODEL",
	"OPENAI_TTS_VOICE",
	"OPENAI_IMAGE_MODEL",
	"OPENAI_IMAGE_SIZE",
	"OPENAI_IMAGE_QUALITY",
	"OPENAI_REASONING_EFFORT",
	"OPENAI_BACKGROUND_REASONING_EFFORT",
	"OPENAI_CLASSIFIER_REASONING_EFFORT",
	"ELEVENLABS_MODEL",
	"INWORLD_MODEL",
	"OPENROUTER_MODEL",
	"OPENROUTER_HTTP_REFERER",
	"OPENROUTER_TITLE",
	"ELEVENLABS_VOICE_ID",
	"FAL_IMAGE_TIMEOUT_MS",
	"SIMPLE_ASSISTANT_MODE",
	"ENABLE_FOLLOW_UPS",
	"ENABLE_CHECK_INS",
	"CHECK_INS_PER_WEEK",
	"ENABLE_CHAT_LOG",
	"CHAT_LOG_RETENTION_DAYS",
	"ENABLE_SLEEP_SCHEDULE",
	"ENABLE_GROUP_VOICE_CONTEXT",
	"GROUP_PASSIVE_VOICE_MAX_SECONDS",
	"GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS",
	"WEATHER_LATITUDE",
	"WEATHER_LONGITUDE",
	"WEATHER_CITY",
	"SHOW_TRANSCRIPTION",
	"LOG_LEVEL",
	"NODE_ENV",
] as const;

function knownEnvVarNames(): Set<string> {
	const names = new Set<string>(CORE_ENV_VARS);
	for (const key of Object.keys(ProviderEnvSchema.shape)) {
		names.add(key);
	}
	const groups: readonly (readonly ProviderOption<string>[])[] = [
		CHAT_PROVIDERS,
		TTS_PROVIDERS,
		STT_PROVIDERS,
		IMAGE_PROVIDERS,
	];
	for (const group of groups) {
		for (const provider of group) {
			for (const required of provider.requiredEnv) {
				names.add(required);
			}
			if (provider.modelEnv) {
				names.add(provider.modelEnv);
			}
		}
	}
	return names;
}

/**
 * Flag .env keys that match a known variable except for letter case
 * (e.g. "FAL_model" vs "FAL_MODEL") — env var names are case-sensitive, so
 * such values are silently ignored and the misconfiguration is invisible.
 */
export function findEnvCaseMismatches(envKeys: Iterable<string>): string[] {
	const known = knownEnvVarNames();
	const byLower = new Map<string, string>();
	for (const name of known) {
		byLower.set(name.toLowerCase(), name);
	}
	const warnings: string[] = [];
	for (const key of envKeys) {
		if (known.has(key)) continue;
		const canonical = byLower.get(key.toLowerCase());
		if (canonical) {
			warnings.push(
				`.env has "${key}" but the bot reads "${canonical}" — env var names are case-sensitive, so this value is being ignored.`,
			);
		}
	}
	return warnings;
}

function parseProviderEnv(env: EnvMap): ProviderEnv {
	const result = safeParseProviderEnv(env);
	if (!result.success) {
		throw new Error(result.error.issues.map(formatZodIssue).join("\n"));
	}
	return result.data as ProviderEnv;
}

function safeParseProviderEnv(env: EnvMap) {
	return ProviderEnvSchema.safeParse(env);
}

function hasRequiredEnv(
	provider: ProviderOption<string>,
	env: ProviderEnv,
): boolean {
	return provider.requiredEnv.every((name) => !!env[name]);
}

function missingRequiredEnv(
	provider: ProviderOption<string>,
	env: ProviderEnv,
): string[] {
	return provider.requiredEnv.filter((name) => !env[name]);
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const key = issue.path.join(".") || "environment";
	return `${key}: ${issue.message}`;
}

function getOption<Name extends string>(
	name: Name,
	options: readonly ProviderOption<Name>[],
): ProviderOption<Name> {
	const provider = options.find((option) => option.name === name);
	if (!provider) throw new Error(`Unknown provider metadata: ${name}`);
	return provider;
}

function isProviderName<Name extends string>(
	value: string,
	options: readonly ProviderOption<Name>[],
): value is Name {
	return options.some((provider) => provider.name === value);
}

export function isChatProviderName(value: string): value is ChatProviderName {
	return isProviderName(value, CHAT_PROVIDERS);
}

export function isTtsProviderName(value: string): value is TtsProviderName {
	return isProviderName(value, TTS_PROVIDERS);
}

export function isSttProviderName(value: string): value is SttProviderName {
	return isProviderName(value, STT_PROVIDERS);
}

export function isImageProviderName(value: string): value is ImageProviderName {
	return isProviderName(value, IMAGE_PROVIDERS);
}

export function resolveChatProviderName(
	env: EnvMap = process.env,
): ChatProviderName {
	return (
		parseProviderEnv(env).CHAT_PROVIDER ?? resolveDefaultChatProviderName(env)
	);
}

export function resolveImageProviderName(
	env: EnvMap = process.env,
): ImageProviderName {
	return (
		parseProviderEnv(env).IMAGE_PROVIDER ?? resolveDefaultImageProviderName(env)
	);
}

export function resolveOpenRouterTransport(
	env: EnvMap = process.env,
): OpenRouterTransport {
	const parsed = parseProviderEnv(env);
	if (parsed.OPENROUTER_TRANSPORT) return parsed.OPENROUTER_TRANSPORT;
	if (parsed.OPENROUTER_API_KEY) return "direct";
	if (parsed.FAL_API_KEY) return "fal";
	return "direct";
}

function normalizeFalImageModelName(value?: string): FalImageModelName | null {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return "nano-banana-pro";

	switch (normalized) {
		case "gpt-image-2":
		case "openai/gpt-image-2":
		case "openai/gpt-image-2/edit":
			return "gpt-image-2";
		case "nano-banana-pro":
		case "fal-ai/nano-banana-pro":
		case "fal-ai/nano-banana-pro/edit":
			return "nano-banana-pro";
		default:
			return null;
	}
}

export function resolveFalImageModelName(
	env: EnvMap = process.env,
): FalImageModelName {
	const model = normalizeFalImageModelName(
		parseProviderEnv(env).FAL_IMAGE_MODEL,
	);
	if (!model) {
		throw new Error("FAL_IMAGE_MODEL must be gpt-image-2 or nano-banana-pro.");
	}
	return model;
}

function normalizeFalImageQuality(value?: string): FalImageQuality | null {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return "high";
	return FAL_IMAGE_QUALITIES.includes(normalized as FalImageQuality)
		? (normalized as FalImageQuality)
		: null;
}

export function resolveFalImageQuality(
	env: EnvMap = process.env,
): FalImageQuality {
	const quality = normalizeFalImageQuality(
		parseProviderEnv(env).FAL_IMAGE_QUALITY,
	);
	if (!quality) {
		throw new Error("FAL_IMAGE_QUALITY must be low, medium, or high.");
	}
	return quality;
}

export function resolveExplicitTtsProviderName(
	env: EnvMap = process.env,
): TtsProviderName | null {
	return parseProviderEnv(env).TTS_PROVIDER ?? null;
}

export function resolveTtsProviderName(
	env: EnvMap = process.env,
): TtsProviderName | null {
	const parsed = parseProviderEnv(env);
	const explicit = parsed.TTS_PROVIDER;
	if (explicit) return explicit;
	if (parsed.ELEVENLABS_API_KEY) return "elevenlabs";
	if (parsed.INWORLD_API_KEY && parsed.INWORLD_VOICE_ID) return "inworld";
	if (parsed.LEMON_FOX_API_KEY) return "lemonfox";
	if (parsed.OPENAI_API_KEY) return "openai";
	return null;
}

export function resolveExplicitSttProviderName(
	env: EnvMap = process.env,
): SttProviderName | null {
	return parseProviderEnv(env).STT_PROVIDER ?? null;
}

export function resolveSttProviderOrder(
	env: EnvMap = process.env,
): SttProviderName[] {
	const parsed = parseProviderEnv(env);
	const explicit = parsed.STT_PROVIDER;
	if (explicit) return [explicit];

	const order: SttProviderName[] = [];
	const platform = resolveAiPlatform(parsed);
	if (platform === "openai") {
		if (parsed.OPENAI_API_KEY) order.push("openai");
		if (parsed.GOOGLE_API_KEY) order.push("gemini");
	} else {
		if (parsed.GOOGLE_API_KEY) order.push("gemini");
		if (parsed.OPENAI_API_KEY) order.push("openai");
	}
	if (parsed.FAL_API_KEY) order.push("fal");
	if (parsed.LEMON_FOX_API_KEY) order.push("lemonfox");
	return order;
}

export function validateProviderConfiguration(env: EnvMap = process.env): {
	errors: string[];
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];
	const parsed = safeParseProviderEnv(env);

	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map(formatZodIssue),
			warnings,
		};
	}

	const providerEnv = parsed.data as ProviderEnv;
	const chatProvider =
		providerEnv.CHAT_PROVIDER ?? resolveDefaultChatProviderName(providerEnv);
	const imageProvider =
		providerEnv.IMAGE_PROVIDER ?? resolveDefaultImageProviderName(providerEnv);
	const falImageModel = normalizeFalImageModelName(providerEnv.FAL_IMAGE_MODEL);
	const falImageQuality = normalizeFalImageQuality(
		providerEnv.FAL_IMAGE_QUALITY,
	);
	const ttsProvider = resolveTtsProviderName(providerEnv);
	const sttOrder = resolveSttProviderOrder(providerEnv);

	if (chatProvider) {
		const provider = getOption(chatProvider, CHAT_PROVIDERS);
		if (chatProvider === "openrouter") {
			const transport = resolveOpenRouterTransport(providerEnv);
			if (transport === "fal") {
				if (!providerEnv.FAL_API_KEY) {
					errors.push(
						"OpenRouter chat via fal.ai requires FAL_API_KEY when CHAT_PROVIDER=openrouter and OPENROUTER_TRANSPORT=fal.",
					);
				}
			} else if (!providerEnv.OPENROUTER_API_KEY) {
				errors.push(
					"OpenRouter chat requires OPENROUTER_API_KEY, or FAL_API_KEY with OPENROUTER_TRANSPORT=fal, when CHAT_PROVIDER=openrouter.",
				);
			}
		} else {
			const missing = missingRequiredEnv(provider, providerEnv);
			if (missing.length > 0) {
				errors.push(
					`${provider.label} chat requires ${missing.join(", ")} when CHAT_PROVIDER=${provider.name}.`,
				);
			}
		}
	}

	if (imageProvider) {
		const provider = getOption(imageProvider, IMAGE_PROVIDERS);
		const missing = missingRequiredEnv(provider, providerEnv);
		if (missing.length > 0) {
			errors.push(
				`${provider.label} images require ${missing.join(", ")} when IMAGE_PROVIDER=${provider.name}.`,
			);
		}
		if (imageProvider === "fal" && !falImageModel) {
			errors.push(
				"fal.ai images require FAL_IMAGE_MODEL to be gpt-image-2 or nano-banana-pro when set.",
			);
		}
		if (
			imageProvider === "fal" &&
			falImageModel === "gpt-image-2" &&
			!falImageQuality
		) {
			errors.push(
				"fal.ai images require FAL_IMAGE_QUALITY to be low, medium, or high when set.",
			);
		}
	}

	if (ttsProvider) {
		const provider = getOption(ttsProvider, TTS_PROVIDERS);
		const missing = missingRequiredEnv(provider, providerEnv);
		if (missing.length > 0) {
			errors.push(
				`${provider.label} TTS requires ${missing.join(", ")} when TTS_PROVIDER=${provider.name}.`,
			);
		}
	} else {
		warnings.push(
			"No TTS provider configured; voice replies will be unavailable.",
		);
	}

	if (sttOrder.length > 0) {
		const firstUnavailable = sttOrder
			.map((name) => getOption(name, STT_PROVIDERS))
			.find((provider) => !hasRequiredEnv(provider, providerEnv));
		if (firstUnavailable) {
			errors.push(
				`${firstUnavailable.label} STT requires ${missingRequiredEnv(firstUnavailable, providerEnv).join(", ")} when STT_PROVIDER=${firstUnavailable.name}.`,
			);
		}
	} else {
		warnings.push("No STT provider configured; voice transcription will fail.");
	}

	if (providerEnv.INWORLD_API_KEY && !providerEnv.INWORLD_VOICE_ID) {
		warnings.push(
			"INWORLD_API_KEY is set without INWORLD_VOICE_ID, so Inworld TTS will not auto-select.",
		);
	}

	if (!providerEnv.GOOGLE_API_KEY && !providerEnv.OPENAI_API_KEY) {
		errors.push(
			"Set OPENAI_API_KEY or GOOGLE_API_KEY. OpenAI alone covers chat, embeddings, STT, TTS, images, PDFs, and background work; Gemini remains optional for YouTube analysis and Gemini-specific models.",
		);
	}

	const supportChecks: Array<{
		label: string;
		name: string;
		provider: "gemini" | "openai" | undefined;
	}> = [
		{
			label: "Embeddings",
			name: "EMBEDDING_PROVIDER",
			provider: providerEnv.EMBEDDING_PROVIDER,
		},
		{
			label: "Vision",
			name: "VISION_PROVIDER",
			provider: providerEnv.VISION_PROVIDER,
		},
		{
			label: "Documents",
			name: "DOCUMENT_PROVIDER",
			provider: providerEnv.DOCUMENT_PROVIDER,
		},
		{
			label: "Background work",
			name: "BACKGROUND_PROVIDER",
			provider: providerEnv.BACKGROUND_PROVIDER,
		},
		{
			label: "Classifiers",
			name: "CLASSIFIER_PROVIDER",
			provider: providerEnv.CLASSIFIER_PROVIDER,
		},
	];
	for (const check of supportChecks) {
		if (!check.provider) continue;
		const required =
			check.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
		if (!providerEnv[required]) {
			errors.push(
				`${check.label} require ${required} when ${check.name}=${check.provider}.`,
			);
		}
	}

	if (
		providerEnv.YOUTUBE_PROVIDER === "openai" ||
		(!providerEnv.GOOGLE_API_KEY && resolveAiPlatform(providerEnv) === "openai")
	) {
		warnings.push(
			"YouTube video analysis is Gemini-only. Without GOOGLE_API_KEY, YouTube links will not be analyzed.",
		);
	}

	return { errors, warnings };
}

export function formatProviderConfigurationFailure(
	validation: { errors: string[] },
	env: EnvMap = process.env,
): string {
	const chatProvider =
		env.CHAT_PROVIDER?.trim() ||
		`${resolveDefaultChatProviderName(env)} (default)`;
	const lines = [
		"Startup blocked: provider configuration is invalid.",
		"",
		`Configured CHAT_PROVIDER: ${chatProvider}`,
		"",
		"Errors:",
		...validation.errors.map((error) => `- ${error}`),
		"",
		"How to fix:",
		"- Add the missing key(s) to .env or the systemd EnvironmentFile.",
		"- If CHAT_PROVIDER=openrouter and you want to use fal.ai, set OPENROUTER_TRANSPORT=fal and FAL_API_KEY.",
		"- If CHAT_PROVIDER=deepseek, set DEEPSEEK_API_KEY and optionally DEEPSEEK_MODEL=deepseek-v4-pro.",
		"- Restart the service after editing env: sudo systemctl restart hellybot",
		"- Full startup logs: sudo journalctl -u hellybot -n 80 --no-pager",
	];

	return lines.join("\n");
}

export function formatProviderStartupSummary(
	env: EnvMap = process.env,
): string[] {
	const chat = resolveChatProviderName(env);
	const chatTransport =
		chat === "openrouter" ? ` (${resolveOpenRouterTransport(env)})` : "";
	const image = resolveImageProviderName(env);
	const tts = resolveTtsProviderName(env) ?? "none";
	const sttOrder = resolveSttProviderOrder(env);
	const stt = sttOrder.length > 0 ? sttOrder.join(" -> ") : "none";
	const falImageModel = image === "fal" ? resolveFalImageModelName(env) : null;
	const imageSummary =
		image === "fal" && falImageModel === "gpt-image-2"
			? `${image} (${falImageModel}, ${resolveFalImageQuality(env)})`
			: image === "fal"
				? `${image} (${falImageModel})`
				: image;

	return [
		`[startup] AI platform: ${resolveAiPlatform(env)}`,
		`[startup] Chat provider: ${chat}${chatTransport}`,
		`[startup] Embeddings: ${resolveEmbeddingProvider(env)}`,
		`[startup] Background: ${resolveBackgroundProvider(env)}`,
		`[startup] STT provider order: ${stt}`,
		`[startup] TTS provider: ${tts}`,
		`[startup] Image provider: ${imageSummary}`,
	];
}

export function formatChatProviderOptions(): string {
	const rows = CHAT_PROVIDERS.map((provider) => {
		const model = provider.modelEnv
			? `${provider.modelEnv} (default: ${provider.defaultModel})`
			: "no model env";
		if (provider.name === "openrouter") {
			return `- ${provider.name}: OPENROUTER_API_KEY direct, or FAL_API_KEY with OPENROUTER_TRANSPORT=fal; ${model}`;
		}
		return `- ${provider.name}: ${provider.requiredEnv.join(" + ")}; ${model}`;
	});

	return rows.join("\n");
}

export function formatProviderCommandStatus(
	current: { provider: string; model: string },
	env: EnvMap = process.env,
): string {
	const tts = resolveTtsProviderName(env) ?? "none";
	const sttOrder = resolveSttProviderOrder(env);
	const stt = sttOrder.length > 0 ? sttOrder.join(" -> ") : "none";
	const image = resolveImageProviderName(env);
	const falImageModel = image === "fal" ? resolveFalImageModelName(env) : null;
	const imageSummary =
		image === "fal" && falImageModel === "gpt-image-2"
			? `${image} (${falImageModel}, ${resolveFalImageQuality(env)})`
			: image === "fal"
				? `${image} (${falImageModel})`
				: image;

	return [
		`Proveedor de chat: ${current.provider}`,
		`Modelo: ${current.model}`,
		"",
		"Proveedores de chat:",
		formatChatProviderOptions(),
		"",
		"Independientes de /provider:",
		`- STT: ${stt} (STT_PROVIDER)`,
		`- TTS: ${tts} (TTS_PROVIDER)`,
		`- Imágenes: ${imageSummary} (IMAGE_PROVIDER, GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL, FAL_IMAGE_MODEL, FAL_IMAGE_QUALITY)`,
		"",
		"/provider solo cambia el chat. Voz, transcripción e imágenes se combinan aparte por env vars.",
	].join("\n");
}
