import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface WizardData {
	botToken: string;
	googleApiKey: string;
	ownerUserId: string;
	allowedGroupId?: string;
}

interface ValidationResult {
	valid: boolean;
	errors: Record<string, string>;
}

function validateInputs(data: WizardData): ValidationResult {
	const errors: Record<string, string> = {};

	if (!data.botToken || !/^\d+:.+$/.test(data.botToken.trim())) {
		errors.botToken =
			"Invalid bot token format. It should look like: 123456789:ABCdefGHI...";
	}

	if (!data.googleApiKey || data.googleApiKey.trim().length === 0) {
		errors.googleApiKey = "Google API key is required.";
	}

	if (!data.ownerUserId || !/^\d+$/.test(data.ownerUserId.trim())) {
		errors.ownerUserId =
			"Invalid user ID. It should be a number like: 123456789";
	}

	if (
		data.allowedGroupId &&
		data.allowedGroupId.trim() !== "" &&
		!/^-?\d+$/.test(data.allowedGroupId.trim())
	) {
		errors.allowedGroupId =
			"Invalid group ID. It should be a number (usually negative, like -1001234567890).";
	}

	return { valid: Object.keys(errors).length === 0, errors };
}

function loadExistingEnv(): Record<string, string> {
	if (!existsSync("./.env")) return {};
	const content = readFileSync("./.env", "utf-8");
	const env: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		env[key] = value;
	}
	return env;
}

function writeEnvFile(data: WizardData): void {
	const existing = loadExistingEnv();

	// Wizard-managed keys
	existing.BOT_TOKEN = data.botToken.trim();
	existing.GOOGLE_API_KEY = data.googleApiKey.trim();
	existing.OWNER_USER_ID = data.ownerUserId.trim();

	if (data.allowedGroupId && data.allowedGroupId.trim() !== "") {
		existing.ALLOWED_GROUP_ID = data.allowedGroupId.trim();
	}

	// Set sensible defaults only if not already present
	if (!existing.CHAT_PROVIDER) existing.CHAT_PROVIDER = "gemini";
	if (!existing.GEMINI_MODEL) existing.GEMINI_MODEL = "gemini-3-flash-preview";
	if (!existing.SIMPLE_ASSISTANT_MODE) existing.SIMPLE_ASSISTANT_MODE = "false";
	if (!existing.ENABLE_FOLLOW_UPS) existing.ENABLE_FOLLOW_UPS = "false";
	if (!existing.NODE_ENV) existing.NODE_ENV = "production";

	const lines: string[] = [];
	for (const [key, value] of Object.entries(existing)) {
		lines.push(`${key}=${value}`);
	}

	writeFileSync("./.env", `${lines.join("\n")}\n`, "utf-8");
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
	errors?: Record<string, string>,
	prefilled?: Record<string, string>,
): string {
	const v = (key: string) => escapeHtml(prefilled?.[key] ?? "");
	const e = (key: string) =>
		errors?.[key] ? `<div class="error">${escapeHtml(errors[key])}</div>` : "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Setup Wizard</title>
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

  ${errors && Object.keys(errors).length > 0 ? '<div class="global-error">Please fix the errors below and try again.</div>' : ""}

  <form method="POST" action="http://127.0.0.1:${port}/" id="wizardForm">

    <!-- Step 0: Welcome -->
    <div class="step active" data-step="0">
      <h1>Welcome to Bot Setup</h1>
      <p class="subtitle">Let's get your Telegram bot configured in a few easy steps.</p>
      <p class="hint">You'll need the following:</p>
      <ul class="welcome-list">
        <li>A Telegram Bot Token (from @BotFather)</li>
        <li>A Google AI API Key (from Google AI Studio)</li>
        <li>Your Telegram User ID (from @userinfobot)</li>
      </ul>
      <div class="btn-row" style="justify-content:flex-end;">
        <button type="button" class="btn-primary" onclick="goStep(1)">Get Started</button>
      </div>
    </div>

    <!-- Step 1: Bot Token -->
    <div class="step" data-step="1">
      <h1>Telegram Bot Token</h1>
      <p class="hint">
        Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram, send <strong>/newbot</strong>, follow the prompts, then copy the token it gives you.
      </p>
      <label for="botToken">Bot Token</label>
      <input type="text" id="botToken" name="botToken" placeholder="123456789:ABCdef..." value="${v("botToken")}" class="${errors?.botToken ? "has-error" : ""}" autocomplete="off" spellcheck="false">
      <div class="format-hint">Format: 123456789:ABCdefGHIjklMNO...</div>
      ${e("botToken")}
      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="goStep(0)">Back</button>
        <button type="button" class="btn-primary" onclick="goStep(2)">Next</button>
      </div>
    </div>

    <!-- Step 2: Google API Key -->
    <div class="step" data-step="2">
      <h1>Google AI API Key</h1>
      <p class="hint">
        Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>, sign in, and create an API key. This is used for the AI model, embeddings, audio, images, and more.
      </p>
      <label for="googleApiKey">API Key</label>
      <input type="text" id="googleApiKey" name="googleApiKey" placeholder="AIza..." value="${v("googleApiKey")}" class="${errors?.googleApiKey ? "has-error" : ""}" autocomplete="off" spellcheck="false">
      ${e("googleApiKey")}
      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="goStep(1)">Back</button>
        <button type="button" class="btn-primary" onclick="goStep(3)">Next</button>
      </div>
    </div>

    <!-- Step 3: User ID + Submit -->
    <div class="step" data-step="3">
      <h1>Telegram User ID</h1>
      <p class="hint">
        Open <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> in Telegram, send <strong>/start</strong>, and copy the numeric ID it replies with.
      </p>
      <label for="ownerUserId">Your User ID</label>
      <input type="text" id="ownerUserId" name="ownerUserId" placeholder="123456789" value="${v("ownerUserId")}" class="${errors?.ownerUserId ? "has-error" : ""}" autocomplete="off" spellcheck="false">
      <div class="format-hint">A numeric ID like 123456789</div>
      ${e("ownerUserId")}

      <details>
        <summary>Advanced: Group Chat ID (optional)</summary>
        <label for="allowedGroupId">Allowed Group ID</label>
        <p class="hint">If you want the bot to work in a group chat, enter the group's ID here. You can get it by adding <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> to the group.</p>
        <input type="text" id="allowedGroupId" name="allowedGroupId" placeholder="-1001234567890" value="${v("allowedGroupId")}" class="${errors?.allowedGroupId ? "has-error" : ""}" autocomplete="off" spellcheck="false">
        <div class="format-hint">Usually a negative number like -1001234567890</div>
        ${e("allowedGroupId")}
      </details>

      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="goStep(2)">Back</button>
        <button type="submit" class="btn-primary" id="submitBtn">Save &amp; Start Bot</button>
      </div>
    </div>

  </form>
</div>

<script>
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

function buildSuccessHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Setup Complete</title>
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
  <h1>Configuration Saved!</h1>
  <p>Your bot is now starting. You can close this tab.<br>
  Head over to Telegram to complete the personality setup.</p>
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

	// Load existing values for pre-filling (--setup re-run)
	const existing = loadExistingEnv();
	const prefilled: Record<string, string> = {
		botToken: existing.BOT_TOKEN ?? "",
		googleApiKey: existing.GOOGLE_API_KEY ?? "",
		ownerUserId: existing.OWNER_USER_ID ?? "",
		allowedGroupId: existing.ALLOWED_GROUP_ID ?? "",
	};

	return new Promise<void>((resolve) => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			async fetch(req) {
				const reqUrl = new URL(req.url);
				if (reqUrl.pathname !== "/") {
					return new Response("Not found", { status: 404 });
				}

				if (req.method === "GET") {
					return new Response(buildWizardHtml(port, undefined, prefilled), {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				}

				if (req.method === "POST") {
					const body = await req.text();
					const fields = parseFormBody(body);

					const data: WizardData = {
						botToken: fields.botToken ?? "",
						googleApiKey: fields.googleApiKey ?? "",
						ownerUserId: fields.ownerUserId ?? "",
						allowedGroupId: fields.allowedGroupId ?? "",
					};

					const result = validateInputs(data);

					if (!result.valid) {
						// Re-render form with errors and entered values
						const filled: Record<string, string> = {
							botToken: data.botToken,
							googleApiKey: data.googleApiKey,
							ownerUserId: data.ownerUserId,
							allowedGroupId: data.allowedGroupId ?? "",
						};
						return new Response(buildWizardHtml(port, result.errors, filled), {
							headers: {
								"Content-Type": "text/html; charset=utf-8",
							},
						});
					}

					// Write .env and signal completion
					writeEnvFile(data);

					// Schedule server shutdown after response is sent
					setTimeout(() => {
						server.stop(true);
						resolve();
					}, 500);

					return new Response(buildSuccessHtml(), {
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
