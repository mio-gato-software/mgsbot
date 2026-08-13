type EnvMap = NodeJS.ProcessEnv;

export type AiPlatform = "gemini" | "openai";
export type SupportProviderName = "gemini" | "openai";

export const DEFAULT_GEMINI_CHAT_MODEL = "gemini-3.6-flash";
export const DEFAULT_GEMINI_BACKGROUND_MODEL = "gemini-3.6-flash";
export const DEFAULT_GEMINI_CLASSIFIER_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_VISION_MODEL = "gemini-3.6-flash";
export const DEFAULT_GEMINI_DOCUMENT_MODEL = "gemini-3.6-flash";
export const DEFAULT_GEMINI_STT_MODEL = "gemini-3.6-flash";
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3-pro-image";
export const DEFAULT_GEMINI_IMAGE_SIZE = "1K";
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_GEMINI_EMBEDDING_DIM = 768;

export const DEFAULT_OPENAI_CHAT_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_BACKGROUND_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_CLASSIFIER_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_VISION_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_DOCUMENT_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_TTS_VOICE = "coral";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
export const DEFAULT_OPENAI_IMAGE_SIZE = "1024x1024";
export const DEFAULT_OPENAI_IMAGE_QUALITY = "high";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_OPENAI_EMBEDDING_DIM = 768;
export const DEFAULT_OPENAI_REASONING_EFFORT = "low";
export const DEFAULT_OPENAI_CLASSIFIER_REASONING_EFFORT = "none";
export const OPENAI_MIN_OUTPUT_TOKENS = 16;
export const OPENAI_CLASSIFIER_REASONING_OUTPUT_HEADROOM = 64;

export const OPENAI_IMAGE_SIZES = [
	"1024x1024",
	"1024x1536",
	"1536x1024",
	"auto",
] as const;
export const OPENAI_IMAGE_QUALITIES = [
	"low",
	"medium",
	"high",
	"auto",
] as const;

export const OPENAI_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

function envString(env: EnvMap, name: string): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

export function hasGoogleApiKey(env: EnvMap = process.env): boolean {
	return !!envString(env, "GOOGLE_API_KEY");
}

export function hasOpenAiApiKey(env: EnvMap = process.env): boolean {
	return !!envString(env, "OPENAI_API_KEY");
}

export function hasAnyAiKey(env: EnvMap = process.env): boolean {
	return hasGoogleApiKey(env) || hasOpenAiApiKey(env);
}

export function resolveAiPlatform(env: EnvMap = process.env): AiPlatform {
	const explicit = envString(env, "AI_PLATFORM")?.toLowerCase();
	if (explicit === "openai" || explicit === "gemini") return explicit;
	if (hasOpenAiApiKey(env) && !hasGoogleApiKey(env)) return "openai";
	return "gemini";
}

function resolveSupportProvider(
	env: EnvMap,
	name: string,
	fallback: SupportProviderName,
): SupportProviderName {
	const explicit = envString(env, name)?.toLowerCase();
	if (explicit === "openai" || explicit === "gemini") return explicit;
	return fallback;
}

export function resolveDefaultChatProviderName(
	env: EnvMap = process.env,
): "gemini" | "openai" {
	return resolveAiPlatform(env) === "openai" ? "openai" : "gemini";
}

export function resolveDefaultImageProviderName(
	env: EnvMap = process.env,
): "gemini" | "openai" {
	return resolveAiPlatform(env) === "openai" ? "openai" : "gemini";
}

export function resolveEmbeddingProvider(
	env: EnvMap = process.env,
): SupportProviderName {
	return resolveSupportProvider(
		env,
		"EMBEDDING_PROVIDER",
		resolveAiPlatform(env),
	);
}

export function resolveVisionProvider(
	env: EnvMap = process.env,
): SupportProviderName {
	return resolveSupportProvider(env, "VISION_PROVIDER", resolveAiPlatform(env));
}

export function resolveDocumentProvider(
	env: EnvMap = process.env,
): SupportProviderName {
	return resolveSupportProvider(
		env,
		"DOCUMENT_PROVIDER",
		resolveAiPlatform(env),
	);
}

export function resolveBackgroundProvider(
	env: EnvMap = process.env,
): SupportProviderName {
	return resolveSupportProvider(
		env,
		"BACKGROUND_PROVIDER",
		resolveAiPlatform(env),
	);
}

export function resolveClassifierProvider(
	env: EnvMap = process.env,
): SupportProviderName {
	return resolveSupportProvider(
		env,
		"CLASSIFIER_PROVIDER",
		resolveAiPlatform(env),
	);
}

export function resolveYouTubeProvider(
	env: EnvMap = process.env,
): SupportProviderName {
	return resolveSupportProvider(env, "YOUTUBE_PROVIDER", "gemini");
}

export function resolveEmbeddingModel(env: EnvMap = process.env): string {
	const explicit = envString(env, "EMBEDDING_MODEL");
	if (explicit) return explicit;
	return resolveEmbeddingProvider(env) === "openai"
		? DEFAULT_OPENAI_EMBEDDING_MODEL
		: DEFAULT_GEMINI_EMBEDDING_MODEL;
}

export function resolveEmbeddingDim(env: EnvMap = process.env): number {
	const raw = envString(env, "EMBEDDING_DIM");
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return resolveEmbeddingProvider(env) === "openai"
		? DEFAULT_OPENAI_EMBEDDING_DIM
		: DEFAULT_GEMINI_EMBEDDING_DIM;
}

export function resolveBackgroundModel(env: EnvMap = process.env): string {
	const explicit = envString(env, "BACKGROUND_MODEL");
	if (explicit) return explicit;
	return resolveBackgroundProvider(env) === "openai"
		? DEFAULT_OPENAI_BACKGROUND_MODEL
		: DEFAULT_GEMINI_BACKGROUND_MODEL;
}

export function resolveClassifierModel(env: EnvMap = process.env): string {
	const explicit = envString(env, "CLASSIFIER_MODEL");
	if (explicit) return explicit;
	return resolveClassifierProvider(env) === "openai"
		? DEFAULT_OPENAI_CLASSIFIER_MODEL
		: DEFAULT_GEMINI_CLASSIFIER_MODEL;
}

export function resolveGeminiVisionModel(env: EnvMap = process.env): string {
	return (
		envString(env, "GEMINI_VISION_MODEL") ??
		envString(env, "GEMINI_MODEL") ??
		DEFAULT_GEMINI_VISION_MODEL
	);
}

export function resolveGeminiDocumentModel(env: EnvMap = process.env): string {
	return (
		envString(env, "GEMINI_DOCUMENT_MODEL") ??
		envString(env, "GEMINI_MODEL") ??
		DEFAULT_GEMINI_DOCUMENT_MODEL
	);
}

export function resolveGeminiSttModel(env: EnvMap = process.env): string {
	return (
		envString(env, "GEMINI_STT_MODEL") ??
		envString(env, "GEMINI_MODEL") ??
		DEFAULT_GEMINI_STT_MODEL
	);
}

export function resolveGeminiImageModel(env: EnvMap = process.env): string {
	return envString(env, "GEMINI_IMAGE_MODEL") ?? DEFAULT_GEMINI_IMAGE_MODEL;
}

export function resolveGeminiImageSize(env: EnvMap = process.env): string {
	return envString(env, "GEMINI_IMAGE_SIZE") ?? DEFAULT_GEMINI_IMAGE_SIZE;
}

export function resolveOpenAIChatModel(env: EnvMap = process.env): string {
	return envString(env, "OPENAI_MODEL") ?? DEFAULT_OPENAI_CHAT_MODEL;
}

export function resolveOpenAIVisionModel(env: EnvMap = process.env): string {
	return (
		envString(env, "OPENAI_VISION_MODEL") ??
		envString(env, "OPENAI_MODEL") ??
		DEFAULT_OPENAI_VISION_MODEL
	);
}

export function resolveOpenAIDocumentModel(env: EnvMap = process.env): string {
	return (
		envString(env, "OPENAI_DOCUMENT_MODEL") ??
		envString(env, "OPENAI_MODEL") ??
		DEFAULT_OPENAI_DOCUMENT_MODEL
	);
}

export function resolveOpenAISttModel(env: EnvMap = process.env): string {
	return envString(env, "OPENAI_STT_MODEL") ?? DEFAULT_OPENAI_STT_MODEL;
}

export function resolveOpenAITtsModel(env: EnvMap = process.env): string {
	return envString(env, "OPENAI_TTS_MODEL") ?? DEFAULT_OPENAI_TTS_MODEL;
}

export function resolveOpenAITtsVoice(env: EnvMap = process.env): string {
	return envString(env, "OPENAI_TTS_VOICE") ?? DEFAULT_OPENAI_TTS_VOICE;
}

export function resolveOpenAIImageModel(env: EnvMap = process.env): string {
	return envString(env, "OPENAI_IMAGE_MODEL") ?? DEFAULT_OPENAI_IMAGE_MODEL;
}

export function resolveOpenAIImageSize(env: EnvMap = process.env): string {
	const value = envString(env, "OPENAI_IMAGE_SIZE");
	if (
		value &&
		OPENAI_IMAGE_SIZES.includes(value as (typeof OPENAI_IMAGE_SIZES)[number])
	) {
		return value;
	}
	return DEFAULT_OPENAI_IMAGE_SIZE;
}

export function resolveOpenAIImageQuality(env: EnvMap = process.env): string {
	const value = envString(env, "OPENAI_IMAGE_QUALITY");
	if (
		value &&
		OPENAI_IMAGE_QUALITIES.includes(
			value as (typeof OPENAI_IMAGE_QUALITIES)[number],
		)
	) {
		return value;
	}
	return DEFAULT_OPENAI_IMAGE_QUALITY;
}

export function openAIModelSupportsReasoning(model: string): boolean {
	const id = model.trim().toLowerCase();
	return !(
		id.startsWith("gpt-4") ||
		id.startsWith("gpt-3") ||
		id.startsWith("chatgpt")
	);
}

export function openaiClassifierMaxOutputTokens(
	requested: number,
	effort: OpenAIReasoningEffort = resolveOpenAIClassifierReasoningEffort(),
): number {
	const outputFloor = Math.max(requested, OPENAI_MIN_OUTPUT_TOKENS);
	if (effort === "none") return outputFloor;
	return outputFloor + OPENAI_CLASSIFIER_REASONING_OUTPUT_HEADROOM;
}

export function resolveOpenAIReasoningEffort(
	env: EnvMap = process.env,
): OpenAIReasoningEffort {
	return normalizeReasoningEffort(
		envString(env, "OPENAI_REASONING_EFFORT"),
		DEFAULT_OPENAI_REASONING_EFFORT,
	);
}

export function resolveOpenAIBackgroundReasoningEffort(
	env: EnvMap = process.env,
): OpenAIReasoningEffort {
	return normalizeReasoningEffort(
		envString(env, "OPENAI_BACKGROUND_REASONING_EFFORT"),
		resolveOpenAIReasoningEffort(env),
	);
}

export function resolveOpenAIClassifierReasoningEffort(
	env: EnvMap = process.env,
): OpenAIReasoningEffort {
	return normalizeReasoningEffort(
		envString(env, "OPENAI_CLASSIFIER_REASONING_EFFORT"),
		DEFAULT_OPENAI_CLASSIFIER_REASONING_EFFORT,
	);
}

function normalizeReasoningEffort(
	value: string | undefined,
	fallback: OpenAIReasoningEffort,
): OpenAIReasoningEffort {
	const normalized = value?.toLowerCase();
	return OPENAI_REASONING_EFFORTS.includes(normalized as OpenAIReasoningEffort)
		? (normalized as OpenAIReasoningEffort)
		: fallback;
}

export function supportProviderHasKey(
	provider: SupportProviderName,
	env: EnvMap = process.env,
): boolean {
	return provider === "openai" ? hasOpenAiApiKey(env) : hasGoogleApiKey(env);
}
