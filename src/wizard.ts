import { type BotLanguage, loadConfig, saveConfig } from "./config.ts";
import { atomicWriteFileSync, parseEnvFile } from "./utils.ts";

interface WizardData {
	botToken: string;
	googleApiKey: string;
	openaiApiKey: string;
	geminiModel: string;
	openaiModel: string;
	ownerUserId: string;
	allowedGroupId?: string;
	language: BotLanguage;
}

interface ValidationResult {
	valid: boolean;
	errors: Record<string, string>;
}

function validateInputs(data: WizardData): ValidationResult {
	const errors: Record<string, string> = {};
	const isEs = data.language === "es";

	if (!data.botToken || !/^\d+:.+$/.test(data.botToken.trim())) {
		errors.botToken = isEs
			? "Formato de token inv\u00e1lido. Debe verse as\u00ed: 123456789:ABCdefGHI..."
			: "Invalid bot token format. It should look like: 123456789:ABCdefGHI...";
	}

	if (
		(!data.googleApiKey || data.googleApiKey.trim().length === 0) &&
		(!data.openaiApiKey || data.openaiApiKey.trim().length === 0)
	) {
		errors.googleApiKey = isEs
			? "Se requiere una clave de OpenAI o de Google."
			: "An OpenAI or Google API key is required.";
	}

	if (!data.ownerUserId || !/^\d+$/.test(data.ownerUserId.trim())) {
		errors.ownerUserId = isEs
			? "ID de usuario inv\u00e1lido. Debe ser un n\u00famero como: 123456789"
			: "Invalid user ID. It should be a number like: 123456789";
	}

	if (
		data.allowedGroupId &&
		data.allowedGroupId.trim() !== "" &&
		!/^-?\d+$/.test(data.allowedGroupId.trim())
	) {
		errors.allowedGroupId = isEs
			? "ID de grupo inv\u00e1lido. Debe ser un n\u00famero (generalmente negativo, como -1001234567890)."
			: "Invalid group ID. It should be a number (usually negative, like -1001234567890).";
	}

	return { valid: Object.keys(errors).length === 0, errors };
}

function writeEnvFile(data: WizardData): void {
	const existing = parseEnvFile();

	// Wizard-managed keys
	existing.BOT_TOKEN = data.botToken.trim();
	if (data.googleApiKey.trim()) {
		existing.GOOGLE_API_KEY = data.googleApiKey.trim();
	}
	if (data.openaiApiKey.trim()) {
		existing.OPENAI_API_KEY = data.openaiApiKey.trim();
	}
	existing.OWNER_USER_ID = data.ownerUserId.trim();

	if (data.allowedGroupId && data.allowedGroupId.trim() !== "") {
		existing.ALLOWED_GROUP_ID = data.allowedGroupId.trim();
	}

	if (data.geminiModel.trim()) {
		existing.GEMINI_MODEL = data.geminiModel.trim();
	}
	if (data.openaiModel.trim()) {
		existing.OPENAI_MODEL = data.openaiModel.trim();
	}

	const hasOpenAI = !!data.openaiApiKey.trim();
	const hasGoogle = !!data.googleApiKey.trim();
	if (!existing.CHAT_PROVIDER && !(hasOpenAI && hasGoogle)) {
		existing.CHAT_PROVIDER = hasOpenAI ? "openai" : "gemini";
	}
	if (!existing.AI_PLATFORM && !(hasOpenAI && hasGoogle)) {
		existing.AI_PLATFORM = hasOpenAI ? "openai" : "gemini";
	}
	if (!existing.SIMPLE_ASSISTANT_MODE) existing.SIMPLE_ASSISTANT_MODE = "false";
	if (!existing.ENABLE_FOLLOW_UPS) existing.ENABLE_FOLLOW_UPS = "false";
	if (!existing.NODE_ENV) existing.NODE_ENV = "production";

	const lines: string[] = [];
	for (const [key, value] of Object.entries(existing)) {
		lines.push(`${key}=${value}`);
	}

	atomicWriteFileSync("./.env", `${lines.join("\n")}\n`, 0o600);

	// Save language to bot config
	const currentConfig = loadConfig();
	currentConfig.language = data.language;
	saveConfig(currentConfig);
}

function parseFormBody(body: string): Record<string, string> {
	const params = new URLSearchParams(body);
	const result: Record<string, string> = {};
	for (const [key, value] of params.entries()) {
		result[key] = value;
	}
	return result;
}

function buildWizardHtml(
	port: number,
	csrfToken: string,
	errors?: Record<string, string>,
	prefilled?: Record<string, string>,
	configuredSecrets?: Record<string, boolean>,
): string {
	const v = (key: string) => escapeHtml(prefilled?.[key] ?? "");
	const e = (key: string) =>
		errors?.[key] ? `<div class="error">${escapeHtml(errors[key])}</div>` : "";
	const initLang = prefilled?.language ?? "es";
	// Secret fields are never prefilled with stored values; show a hint instead
	const sp = (key: string, fallback: string) =>
		configuredSecrets?.[key]
			? initLang === "es"
				? "(configurado — dejar en blanco para mantener)"
				: "(configured — leave blank to keep)"
			: fallback;

	return `<!DOCTYPE html>
<html lang="${initLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title data-i18n="title">Bot Setup Wizard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f0f2f5;
    color: #1a1a2e;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    max-width: 600px;
    width: 100%;
    padding: 40px;
  }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: #666; margin-bottom: 32px; font-size: 14px; }
  .steps {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 32px;
  }
  .dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: #ddd;
    transition: background 0.3s;
  }
  .dot.active { background: #2563eb; }
  .dot.done { background: #22c55e; }
  .step { display: none; }
  .step.active { display: block; }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 6px;
    font-size: 14px;
  }
  .hint {
    color: #666;
    font-size: 13px;
    margin-bottom: 12px;
    line-height: 1.5;
  }
  .hint a { color: #2563eb; text-decoration: none; }
  .hint a:hover { text-decoration: underline; }
  input[type="text"] {
    width: 100%;
    padding: 10px 14px;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    font-size: 15px;
    font-family: inherit;
    transition: border-color 0.2s;
    outline: none;
  }
  input[type="text"]:focus { border-color: #2563eb; }
  input[type="text"].has-error { border-color: #ef4444; }
  .error { color: #ef4444; font-size: 13px; margin-top: 6px; }
  .btn-row {
    display: flex;
    justify-content: space-between;
    margin-top: 28px;
    gap: 12px;
  }
  button {
    padding: 10px 24px;
    border-radius: 8px;
    border: none;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s, opacity 0.2s;
  }
  .btn-primary { background: #2563eb; color: #fff; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-secondary { background: #e2e8f0; color: #1a1a2e; }
  .btn-secondary:hover { background: #cbd5e1; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  details { margin-top: 20px; }
  summary {
    cursor: pointer;
    color: #2563eb;
    font-size: 14px;
    font-weight: 600;
  }
  details[open] summary { margin-bottom: 12px; }
  .format-hint {
    font-size: 12px;
    color: #94a3b8;
    margin-top: 4px;
    font-family: monospace;
  }
  .welcome-list {
    list-style: none;
    margin: 16px 0 24px;
  }
  .welcome-list li {
    padding: 6px 0;
    font-size: 14px;
    color: #444;
  }
  .welcome-list li::before {
    content: "\\2713";
    color: #22c55e;
    font-weight: bold;
    margin-right: 8px;
  }
  .global-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 20px;
    color: #dc2626;
    font-size: 14px;
  }
  .model-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
    margin-bottom: 4px;
  }
  .model-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
  }
  .model-option:hover { border-color: #93c5fd; background: #f8fafc; }
  .model-option.selected { border-color: #2563eb; background: #eff6ff; }
  .model-option input[type="radio"] { margin-top: 3px; accent-color: #2563eb; }
  .model-option .model-info { flex: 1; }
  .model-option .model-name { font-weight: 600; font-size: 14px; }
  .model-option .model-desc { font-size: 13px; color: #666; margin-top: 2px; }
</style>
</head>
<body>
<div class="card">
  <div class="steps">
    <div class="dot active" data-step="0"></div>
    <div class="dot" data-step="1"></div>
    <div class="dot" data-step="2"></div>
    <div class="dot" data-step="3"></div>
  </div>

  ${errors && Object.keys(errors).length > 0 ? '<div class="global-error" data-i18n="globalError">Please fix the errors below and try again.</div>' : ""}

  <form method="POST" action="http://127.0.0.1:${port}/" id="wizardForm">
    <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">

    <!-- Step 0: Welcome + Language -->
    <div class="step active" data-step="0">
      <h1 data-i18n="welcomeTitle">Welcome to Bot Setup</h1>
      <p class="subtitle" data-i18n="welcomeSubtitle">Let's get your Telegram bot configured in a few easy steps.</p>
      <label data-i18n="langLabel">Bot Language</label>
      <p class="hint" data-i18n="langHint">Choose the language for your bot's personality and responses.</p>
      <div class="model-options">
        <label class="model-option${initLang === "es" ? " selected" : ""}" id="opt-lang-es">
          <input type="radio" name="language" value="es" ${initLang === "es" ? "checked" : ""}>
          <div class="model-info">
            <div class="model-name">Espa\u00f1ol</div>
            <div class="model-desc">El bot conversar\u00e1 en espa\u00f1ol por defecto.</div>
          </div>
        </label>
        <label class="model-option${initLang === "en" ? " selected" : ""}" id="opt-lang-en">
          <input type="radio" name="language" value="en" ${initLang === "en" ? "checked" : ""}>
          <div class="model-info">
            <div class="model-name">English</div>
            <div class="model-desc">The bot will converse in English by default.</div>
          </div>
        </label>
      </div>
      <p class="hint" style="margin-top: 16px;" data-i18n="needList">You'll need the following:</p>
      <ul class="welcome-list">
        <li data-i18n="needToken">A Telegram Bot Token (from @BotFather)</li>
        <li data-i18n="needApiKey">An OpenAI API key, or a Google AI API key</li>
        <li data-i18n="needUserId">Your Telegram User ID (from @userinfobot)</li>
      </ul>
      <div class="btn-row" style="justify-content:flex-end;">
        <button type="button" class="btn-primary" onclick="goStep(1)" data-i18n="getStarted">Get Started</button>
      </div>
    </div>

    <!-- Step 1: Bot Token -->
    <div class="step" data-step="1">
      <h1 data-i18n="tokenTitle">Telegram Bot Token</h1>
      <p class="hint" data-i18n-html="tokenHint">
        Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram, send <strong>/newbot</strong>, follow the prompts, then copy the token it gives you.
      </p>
      <label for="botToken" data-i18n="tokenLabel">Bot Token</label>
      <input type="text" id="botToken" name="botToken" placeholder="${sp("botToken", "123456789:ABCdef...")}" value="${v("botToken")}" class="${errors?.botToken ? "has-error" : ""}" autocomplete="off" spellcheck="false">
      <div class="format-hint" data-i18n="tokenFormat">Format: 123456789:ABCdefGHIjklMNO...</div>
      ${e("botToken")}
      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="goStep(0)" data-i18n="back">Back</button>
        <button type="button" class="btn-primary" onclick="goStep(2)" data-i18n="next">Next</button>
      </div>
    </div>

    <!-- Step 2: API keys -->
    <div class="step" data-step="2">
      <h1 data-i18n="apiKeyTitle">AI API Keys</h1>
      <p class="hint" data-i18n-html="apiKeyHint">
        Provide an <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">OpenAI API key</a> and/or a <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> key. OpenAI alone covers most features (chat, memory, STT, TTS, images, PDFs). Gemini is optional and still required for YouTube analysis.
      </p>
      <label for="openaiApiKey" data-i18n="openaiKeyLabel">OpenAI API Key</label>
      <input type="text" id="openaiApiKey" name="openaiApiKey" placeholder="${sp("openaiApiKey", "sk-...")}" value="${v("openaiApiKey")}" autocomplete="off" spellcheck="false">
      <label for="googleApiKey" style="margin-top: 16px;" data-i18n="apiKeyLabel">Google AI API Key</label>
      <input type="text" id="googleApiKey" name="googleApiKey" placeholder="${sp("googleApiKey", "AIza...")}" value="${v("googleApiKey")}" class="${errors?.googleApiKey ? "has-error" : ""}" autocomplete="off" spellcheck="false">
      ${e("googleApiKey")}

      <label style="margin-top: 20px;" data-i18n="modelLabel">Default OpenAI model</label>
      <input type="text" id="openaiModel" name="openaiModel" placeholder="gpt-5.6-luna" value="${v("openaiModel") || "gpt-5.6-luna"}" autocomplete="off" spellcheck="false">

      <label style="margin-top: 20px;" data-i18n="geminiModelLabel">Gemini model (if using Google)</label>
      <div class="model-options">
        <label class="model-option${(prefilled?.geminiModel ?? "gemini-3.6-flash") === "gemini-3.6-flash" ? " selected" : ""}" id="opt-flash">
          <input type="radio" name="geminiModel" value="gemini-3.6-flash" ${(prefilled?.geminiModel ?? "gemini-3.6-flash") === "gemini-3.6-flash" ? "checked" : ""}>
          <div class="model-info">
            <div class="model-name" data-i18n="flashName">Gemini 3.6 Flash</div>
            <div class="model-desc" data-i18n="flashDesc">Fast, capable, and cheap per token.</div>
          </div>
        </label>
        <label class="model-option${prefilled?.geminiModel === "gemini-3.1-pro-preview" ? " selected" : ""}" id="opt-pro">
          <input type="radio" name="geminiModel" value="gemini-3.1-pro-preview" ${prefilled?.geminiModel === "gemini-3.1-pro-preview" ? "checked" : ""}>
          <div class="model-info">
            <div class="model-name" data-i18n="proName">Gemini 3.1 Pro</div>
            <div class="model-desc" data-i18n="proDesc">Smarter and more nuanced, but costs more.</div>
          </div>
        </label>
      </div>

      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="goStep(1)" data-i18n="back">Back</button>
        <button type="button" class="btn-primary" onclick="goStep(3)" data-i18n="next">Next</button>
      </div>
    </div>

    <!-- Step 3: User ID + Submit -->
    <div class="step" data-step="3">
      <h1 data-i18n="userIdTitle">Telegram User ID</h1>
      <p class="hint" data-i18n-html="userIdHint">
        Open <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> in Telegram, send <strong>/start</strong>, and copy the numeric ID it replies with.
      </p>
      <label for="ownerUserId" data-i18n="userIdLabel">Your User ID</label>
      <input type="text" id="ownerUserId" name="ownerUserId" placeholder="123456789" value="${v("ownerUserId")}" class="${errors?.ownerUserId ? "has-error" : ""}" autocomplete="off" spellcheck="false">
      <div class="format-hint" data-i18n="userIdFormat">A numeric ID like 123456789</div>
      ${e("ownerUserId")}

      <details>
        <summary data-i18n="groupAdvanced">Advanced: Group Chat ID (optional)</summary>
        <label for="allowedGroupId" data-i18n="groupLabel">Allowed Group ID</label>
        <p class="hint" data-i18n-html="groupHint">If you want the bot to work in a group chat, enter the group's ID here. You can get it by adding <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> to the group.</p>
        <input type="text" id="allowedGroupId" name="allowedGroupId" placeholder="-1001234567890" value="${v("allowedGroupId")}" class="${errors?.allowedGroupId ? "has-error" : ""}" autocomplete="off" spellcheck="false">
        <div class="format-hint" data-i18n="groupFormat">Usually a negative number like -1001234567890</div>
        ${e("allowedGroupId")}
      </details>

      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="goStep(2)" data-i18n="back">Back</button>
        <button type="submit" class="btn-primary" id="submitBtn" data-i18n="submit">Save &amp; Start Bot</button>
      </div>
    </div>

  </form>
</div>

<script>
  var i18n = {
    en: {
      title: "Bot Setup Wizard",
      globalError: "Please fix the errors below and try again.",
      welcomeTitle: "Welcome to Bot Setup",
      welcomeSubtitle: "Let's get your Telegram bot configured in a few easy steps.",
      langLabel: "Bot Language",
      langHint: "Choose the language for your bot's personality and responses.",
      needList: "You'll need the following:",
      needToken: "A Telegram Bot Token (from @BotFather)",
      needApiKey: "An OpenAI API key, or a Google AI API key",
      needUserId: "Your Telegram User ID (from @userinfobot)",
      getStarted: "Get Started",
      tokenTitle: "Telegram Bot Token",
      tokenHint: 'Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram, send <strong>/newbot</strong>, follow the prompts, then copy the token it gives you.',
      tokenLabel: "Bot Token",
      tokenFormat: "Format: 123456789:ABCdefGHIjklMNO...",
      back: "Back",
      next: "Next",
      apiKeyTitle: "AI API Keys",
      apiKeyHint: 'Provide an <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">OpenAI API key</a> and/or a <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> key. OpenAI alone covers most features. Gemini remains optional.',
      apiKeyLabel: "Google AI API Key",
      openaiKeyLabel: "OpenAI API Key",
      modelLabel: "Default OpenAI model",
      geminiModelLabel: "Gemini model (if using Google)",
      flashName: "Gemini 3.6 Flash",
      flashDesc: "Fast, capable, and cheap per token.",
      proName: "Gemini 3.1 Pro",
      proDesc: "Smarter and more nuanced, but costs more. Best for deeper conversations.",
      userIdTitle: "Telegram User ID",
      userIdHint: 'Open <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> in Telegram, send <strong>/start</strong>, and copy the numeric ID it replies with.',
      userIdLabel: "Your User ID",
      userIdFormat: "A numeric ID like 123456789",
      groupAdvanced: "Advanced: Group Chat ID (optional)",
      groupLabel: "Allowed Group ID",
      groupHint: 'If you want the bot to work in a group chat, enter the group\\'s ID here. You can get it by adding <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> to the group.',
      groupFormat: "Usually a negative number like -1001234567890",
      submit: "Save & Start Bot"
    },
    es: {
      title: "Asistente de Configuraci\\u00f3n",
      globalError: "Por favor corrige los errores e int\\u00e9ntalo de nuevo.",
      welcomeTitle: "Configuraci\\u00f3n del Bot",
      welcomeSubtitle: "Configuremos tu bot de Telegram en unos sencillos pasos.",
      langLabel: "Idioma del Bot",
      langHint: "Elige el idioma para la personalidad y respuestas de tu bot.",
      needList: "Necesitar\\u00e1s lo siguiente:",
      needToken: "Un Token de Bot de Telegram (de @BotFather)",
      needApiKey: "Una clave de OpenAI o una clave de Google AI",
      needUserId: "Tu ID de Usuario de Telegram (de @userinfobot)",
      getStarted: "Comenzar",
      tokenTitle: "Token del Bot de Telegram",
      tokenHint: 'Abre <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> en Telegram, env\\u00eda <strong>/newbot</strong>, sigue las instrucciones y copia el token que te da.',
      tokenLabel: "Token del Bot",
      tokenFormat: "Formato: 123456789:ABCdefGHIjklMNO...",
      back: "Volver",
      next: "Siguiente",
      apiKeyTitle: "Claves API de IA",
      apiKeyHint: 'Proporciona una <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">clave de OpenAI</a> y/o una de <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. Con solo OpenAI cubres casi todo. Gemini es opcional.',
      apiKeyLabel: "Clave API de Google AI",
      openaiKeyLabel: "Clave API de OpenAI",
      modelLabel: "Modelo OpenAI por defecto",
      geminiModelLabel: "Modelo Gemini (si usas Google)",
      flashName: "Gemini 3.6 Flash",
      flashDesc: "R\\u00e1pido, capaz y econ\\u00f3mico por token.",
      proName: "Gemini 3.1 Pro",
      proDesc: "M\\u00e1s inteligente y matizado, pero cuesta m\\u00e1s. Mejor para conversaciones profundas.",
      userIdTitle: "ID de Usuario de Telegram",
      userIdHint: 'Abre <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> en Telegram, env\\u00eda <strong>/start</strong> y copia el ID num\\u00e9rico que te responde.',
      userIdLabel: "Tu ID de Usuario",
      userIdFormat: "Un ID num\\u00e9rico como 123456789",
      groupAdvanced: "Avanzado: ID del grupo (opcional)",
      groupLabel: "ID del Grupo Permitido",
      groupHint: 'Si quieres que el bot funcione en un grupo, ingresa el ID del grupo aqu\\u00ed. Puedes obtenerlo agregando <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> al grupo.',
      groupFormat: "Generalmente un n\\u00famero negativo como -1001234567890",
      submit: "Guardar e Iniciar Bot"
    }
  };

  var currentLang = "${initLang}";

  function applyLang(lang) {
    currentLang = lang;
    var strings = i18n[lang];
    if (!strings) return;
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      if (strings[key] != null) el.textContent = strings[key];
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-html');
      if (strings[key] != null) el.innerHTML = strings[key];
    });
  }

  var currentStep = ${errors && Object.keys(errors).length > 0 ? findFirstErrorStep(errors) : 0};
  function goStep(n) {
    document.querySelectorAll('.step').forEach(function(el) { el.classList.remove('active'); });
    document.querySelectorAll('.dot').forEach(function(el, i) {
      el.classList.remove('active');
      el.classList.remove('done');
      if (i < n) el.classList.add('done');
      if (i === n) el.classList.add('active');
    });
    document.querySelector('.step[data-step="' + n + '"]').classList.add('active');
    currentStep = n;
  }
  // If there are errors, jump to the right step
  if (currentStep > 0) goStep(currentStep);
  // Toggle selected class on radio button groups
  ['geminiModel', 'language'].forEach(function(name) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        this.closest('.model-options').querySelectorAll('.model-option').forEach(function(el) { el.classList.remove('selected'); });
        this.closest('.model-option').classList.add('selected');
      });
    });
  });
  // Switch wizard language when language radio changes
  document.querySelectorAll('input[name="language"]').forEach(function(radio) {
    radio.addEventListener('change', function() { applyLang(this.value); });
  });
  // Apply initial language
  applyLang(currentLang);
</script>
</body>
</html>`;
}

function findFirstErrorStep(errors: Record<string, string>): number {
	if (errors.botToken) return 1;
	if (errors.googleApiKey) return 2;
	if (errors.ownerUserId || errors.allowedGroupId) return 3;
	return 0;
}

function buildSuccessHtml(lang: BotLanguage): string {
	const isEs = lang === "es";
	const title = isEs ? "Configuraci\u00f3n Guardada" : "Configuration Saved!";
	const subtitle = isEs
		? "Tu bot se est\u00e1 iniciando. Puedes cerrar esta pesta\u00f1a.<br>Ve a Telegram para completar la configuraci\u00f3n de personalidad."
		: "Your bot is now starting. You can close this tab.<br>Head over to Telegram to complete the personality setup.";

	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f0f2f5;
    color: #1a1a2e;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    max-width: 600px;
    width: 100%;
    padding: 40px;
    text-align: center;
  }
  .checkmark {
    width: 64px; height: 64px;
    margin: 0 auto 20px;
    background: #22c55e;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    color: #fff;
  }
  h1 { font-size: 24px; margin-bottom: 12px; }
  p { color: #666; font-size: 15px; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="checkmark">&#10003;</div>
  <h1>${title}</h1>
  <p>${subtitle}</p>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

async function findAvailablePort(preferred: number): Promise<number> {
	for (let port = preferred; port < preferred + 10; port++) {
		try {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch: () => new Response(""),
			});
			server.stop(true);
			return port;
		} catch {}
	}
	// Fallback: let OS assign
	return 0;
}

function openBrowser(url: string): void {
	const platform = process.platform;
	try {
		if (platform === "win32") {
			Bun.spawn(["cmd", "/c", "start", url], {
				stdio: ["ignore", "ignore", "ignore"],
			});
		} else if (platform === "darwin") {
			Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
		} else {
			Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
		}
	} catch {
		// Browser open failed — user can copy URL from terminal
	}
}

export async function runSetupWizard(): Promise<void> {
	const port = await findAvailablePort(3000);
	const url = `http://127.0.0.1:${port}/`;

	// Load existing values for pre-filling (--setup re-run).
	// Secret values are never sent to the browser; blank submissions keep them.
	const existing = parseEnvFile();
	const existingConfig = loadConfig();
	const prefilled: Record<string, string> = {
		botToken: "",
		googleApiKey: "",
		openaiApiKey: "",
		geminiModel: existing.GEMINI_MODEL ?? "gemini-3.6-flash",
		openaiModel: existing.OPENAI_MODEL ?? "gpt-5.6-luna",
		ownerUserId: existing.OWNER_USER_ID ?? "",
		allowedGroupId: existing.ALLOWED_GROUP_ID ?? "",
		language: existingConfig.language ?? "es",
	};
	const configuredSecrets: Record<string, boolean> = {
		botToken: Boolean(existing.BOT_TOKEN),
		googleApiKey: Boolean(existing.GOOGLE_API_KEY),
		openaiApiKey: Boolean(existing.OPENAI_API_KEY),
	};

	// Per-run CSRF token; also validate Host/Origin against loopback origins
	const csrfToken = crypto.randomUUID();

	return new Promise<void>((resolve) => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			async fetch(req) {
				// The listen port is fixed (findAvailablePort ran before serve), so
				// validate against it directly instead of reading server.port.
				const serverPort = port;
				const host = req.headers.get("host");
				if (
					host !== `127.0.0.1:${serverPort}` &&
					host !== `localhost:${serverPort}`
				) {
					return new Response("Forbidden", { status: 403 });
				}

				const reqUrl = new URL(req.url);
				if (reqUrl.pathname !== "/") {
					return new Response("Not found", { status: 404 });
				}

				if (req.method === "GET") {
					return new Response(
						buildWizardHtml(
							serverPort,
							csrfToken,
							undefined,
							prefilled,
							configuredSecrets,
						),
						{
							headers: { "Content-Type": "text/html; charset=utf-8" },
						},
					);
				}

				if (req.method === "POST") {
					const origin = req.headers.get("origin");
					if (
						origin !== null &&
						origin !== `http://127.0.0.1:${serverPort}` &&
						origin !== `http://localhost:${serverPort}`
					) {
						return new Response("Forbidden", { status: 403 });
					}

					const body = await req.text();
					const fields = parseFormBody(body);

					if (fields.csrfToken !== csrfToken) {
						return new Response("Forbidden", { status: 403 });
					}

					// Blank secret fields keep the previously configured values
					const submittedBotToken = (fields.botToken ?? "").trim();
					const submittedApiKey = (fields.googleApiKey ?? "").trim();
					const submittedOpenAiKey = (fields.openaiApiKey ?? "").trim();

					const data: WizardData = {
						botToken: submittedBotToken || (existing.BOT_TOKEN ?? ""),
						googleApiKey: submittedApiKey || (existing.GOOGLE_API_KEY ?? ""),
						openaiApiKey: submittedOpenAiKey || (existing.OPENAI_API_KEY ?? ""),
						geminiModel: fields.geminiModel ?? "gemini-3.6-flash",
						openaiModel: fields.openaiModel ?? "gpt-5.6-luna",
						ownerUserId: fields.ownerUserId ?? "",
						allowedGroupId: fields.allowedGroupId ?? "",
						language: (fields.language === "en" ? "en" : "es") as BotLanguage,
					};

					const result = validateInputs(data);

					if (!result.valid) {
						// Re-render form with errors and entered values
						// (secrets echo only what the user typed, never stored values)
						const filled: Record<string, string> = {
							botToken: submittedBotToken,
							googleApiKey: submittedApiKey,
							openaiApiKey: submittedOpenAiKey,
							geminiModel: data.geminiModel,
							openaiModel: data.openaiModel,
							ownerUserId: data.ownerUserId,
							allowedGroupId: data.allowedGroupId ?? "",
							language: data.language,
						};
						return new Response(
							buildWizardHtml(
								serverPort,
								csrfToken,
								result.errors,
								filled,
								configuredSecrets,
							),
							{
								headers: {
									"Content-Type": "text/html; charset=utf-8",
								},
							},
						);
					}

					// Write .env and signal completion
					writeEnvFile(data);

					// Schedule server shutdown after response is sent
					setTimeout(() => {
						server.stop(true);
						resolve();
					}, 500);

					return new Response(buildSuccessHtml(data.language), {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				}

				return new Response("Method not allowed", { status: 405 });
			},
		});

		const actualPort = server.port;
		const actualUrl =
			actualPort !== port ? `http://127.0.0.1:${actualPort}/` : url;

		console.log("");
		console.log(
			"\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557",
		);
		console.log("\u2551           Bot Setup Wizard                   \u2551");
		console.log(
			"\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563",
		);
		console.log(`\u2551  Open in your browser: ${actualUrl.padEnd(20)} \u2551`);
		console.log("\u2551                                              \u2551");
		console.log("\u2551  Waiting for configuration...                \u2551");
		console.log("\u2551  (Press Ctrl+C to cancel)                    \u2551");
		console.log(
			"\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D",
		);
		console.log("");

		openBrowser(actualUrl);
	});
}
