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
		defaultModel: "gemini-3-flash-preview",
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
		defaultModel: "gpt-5.4",
		description:
			"Chat through OpenAI; image descriptions can use vision models.",
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
		description: "Third automatic fallback when LEMON_FOX_API_KEY is set.",
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
		description: "Alternative image provider using nano-banana-pro.",
	},
] as const satisfies readonly ProviderOption<string>[];

export type ChatProviderName = (typeof CHAT_PROVIDERS)[number]["name"];
export type TtsProviderName = (typeof TTS_PROVIDERS)[number]["name"];
export type SttProviderName = (typeof STT_PROVIDERS)[number]["name"];
export type ImageProviderName = (typeof IMAGE_PROVIDERS)[number]["name"];

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

function isProviderName<Name extends string>(
	value: string,
	options: readonly ProviderOption<Name>[],
): value is Name {
	return options.some((provider) => provider.name === value);
}

function normalizeProviderValue(value: string | undefined): string | null {
	const normalized = value?.trim().toLowerCase();
	return normalized ? normalized : null;
}

function hasRequiredEnv(
	provider: ProviderOption<string>,
	env: EnvMap,
): boolean {
	return provider.requiredEnv.every((name) => !!env[name]);
}

function missingRequiredEnv(
	provider: ProviderOption<string>,
	env: EnvMap,
): string[] {
	return provider.requiredEnv.filter((name) => !env[name]);
}

function getOption<Name extends string>(
	name: Name,
	options: readonly ProviderOption<Name>[],
): ProviderOption<Name> {
	const provider = options.find((option) => option.name === name);
	if (!provider) throw new Error(`Unknown provider metadata: ${name}`);
	return provider;
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
	const raw = normalizeProviderValue(env.CHAT_PROVIDER) ?? "gemini";
	if (!isChatProviderName(raw)) {
		throw new Error(
			`Invalid CHAT_PROVIDER="${raw}". Valid values: ${CHAT_PROVIDER_NAMES.join(", ")}`,
		);
	}
	return raw;
}

export function resolveImageProviderName(
	env: EnvMap = process.env,
): ImageProviderName {
	const raw = normalizeProviderValue(env.IMAGE_PROVIDER) ?? "gemini";
	if (!isImageProviderName(raw)) {
		throw new Error(
			`Invalid IMAGE_PROVIDER="${raw}". Valid values: ${IMAGE_PROVIDER_NAMES.join(", ")}`,
		);
	}
	return raw;
}

export function resolveExplicitTtsProviderName(
	env: EnvMap = process.env,
): TtsProviderName | null {
	const raw = normalizeProviderValue(env.TTS_PROVIDER);
	if (!raw) return null;
	if (!isTtsProviderName(raw)) {
		throw new Error(
			`Invalid TTS_PROVIDER="${raw}". Valid values: ${TTS_PROVIDER_NAMES.join(", ")}`,
		);
	}
	return raw;
}

export function resolveTtsProviderName(
	env: EnvMap = process.env,
): TtsProviderName | null {
	const explicit = resolveExplicitTtsProviderName(env);
	if (explicit) return explicit;
	if (env.ELEVENLABS_API_KEY) return "elevenlabs";
	if (env.INWORLD_API_KEY && env.INWORLD_VOICE_ID) return "inworld";
	if (env.LEMON_FOX_API_KEY) return "lemonfox";
	return null;
}

export function resolveExplicitSttProviderName(
	env: EnvMap = process.env,
): SttProviderName | null {
	const raw = normalizeProviderValue(env.STT_PROVIDER);
	if (!raw) return null;
	if (!isSttProviderName(raw)) {
		throw new Error(
			`Invalid STT_PROVIDER="${raw}". Valid values: ${STT_PROVIDER_NAMES.join(", ")}`,
		);
	}
	return raw;
}

export function resolveSttProviderOrder(
	env: EnvMap = process.env,
): SttProviderName[] {
	const explicit = resolveExplicitSttProviderName(env);
	if (explicit) return [explicit];

	const order: SttProviderName[] = [];
	if (env.GOOGLE_API_KEY) order.push("gemini");
	if (env.FAL_API_KEY) order.push("fal");
	if (env.LEMON_FOX_API_KEY) order.push("lemonfox");
	return order;
}

export function validateProviderConfiguration(env: EnvMap = process.env): {
	errors: string[];
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];

	let chatProvider: ChatProviderName | null = null;
	let imageProvider: ImageProviderName | null = null;
	let ttsProvider: TtsProviderName | null = null;
	let sttOrder: SttProviderName[] = [];

	try {
		chatProvider = resolveChatProviderName(env);
	} catch (error) {
		errors.push(String(error instanceof Error ? error.message : error));
	}

	try {
		imageProvider = resolveImageProviderName(env);
	} catch (error) {
		errors.push(String(error instanceof Error ? error.message : error));
	}

	try {
		ttsProvider = resolveTtsProviderName(env);
	} catch (error) {
		errors.push(String(error instanceof Error ? error.message : error));
	}

	try {
		sttOrder = resolveSttProviderOrder(env);
	} catch (error) {
		errors.push(String(error instanceof Error ? error.message : error));
	}

	if (chatProvider) {
		const provider = getOption(chatProvider, CHAT_PROVIDERS);
		const missing = missingRequiredEnv(provider, env);
		if (missing.length > 0) {
			errors.push(
				`${provider.label} chat requires ${missing.join(", ")} when CHAT_PROVIDER=${provider.name}.`,
			);
		}
	}

	if (imageProvider) {
		const provider = getOption(imageProvider, IMAGE_PROVIDERS);
		const missing = missingRequiredEnv(provider, env);
		if (missing.length > 0) {
			errors.push(
				`${provider.label} images require ${missing.join(", ")} when IMAGE_PROVIDER=${provider.name}.`,
			);
		}
	}

	if (ttsProvider) {
		const provider = getOption(ttsProvider, TTS_PROVIDERS);
		const missing = missingRequiredEnv(provider, env);
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
			.find((provider) => !hasRequiredEnv(provider, env));
		if (firstUnavailable) {
			errors.push(
				`${firstUnavailable.label} STT requires ${missingRequiredEnv(firstUnavailable, env).join(", ")} when STT_PROVIDER=${firstUnavailable.name}.`,
			);
		}
	} else {
		warnings.push("No STT provider configured; voice transcription will fail.");
	}

	if (env.INWORLD_API_KEY && !env.INWORLD_VOICE_ID) {
		warnings.push(
			"INWORLD_API_KEY is set without INWORLD_VOICE_ID, so Inworld TTS will not auto-select.",
		);
	}

	return { errors, warnings };
}

export function formatProviderStartupSummary(
	env: EnvMap = process.env,
): string[] {
	const chat = resolveChatProviderName(env);
	const image = resolveImageProviderName(env);
	const tts = resolveTtsProviderName(env) ?? "none";
	const sttOrder = resolveSttProviderOrder(env);
	const stt = sttOrder.length > 0 ? sttOrder.join(" -> ") : "none";

	return [
		`[startup] Chat provider: ${chat}`,
		`[startup] STT provider order: ${stt}`,
		`[startup] TTS provider: ${tts}`,
		`[startup] Image provider: ${image}`,
	];
}

export function formatChatProviderOptions(): string {
	const rows = CHAT_PROVIDERS.map((provider) => {
		const model = provider.modelEnv
			? `${provider.modelEnv} (default: ${provider.defaultModel})`
			: "no model env";
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
		`- Imágenes: ${image} (IMAGE_PROVIDER)`,
		"",
		"/provider solo cambia el chat. Voz, transcripción e imágenes se combinan aparte por env vars.",
	].join("\n");
}
