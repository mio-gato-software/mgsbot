# MGS Bot

<p align="center">
  <img src="assets/bot-avatar.png" alt="MGS Bot" width="300" />
</p>

A conversational Telegram bot with persistent memory, a configurable personality, voice replies, and image generation. Built with Bun, TypeScript, and grammY, for one owner in DMs and optionally one allowed group.

- Remembers facts, conversation summaries, relationships, and monthly chapters; adaptive personality learns gradually from direct user feedback.
- Handles text, `.txt` files, voice notes, audio, photos, PDFs, public web pages, and YouTube links.
- Generates character photos, edits user images, and creates illustrations for scheduled reports.
- Supports natural-language reminders, recurring research, source/style preferences, and conditional actions such as a celebration meme after a confirmed win.
- Searches the web, reads public pages, and checks current/hourly weather with any chat provider.
- Offers opt-in DM follow-ups and periodic check-ins.

## Quick start

Use **Bun 1.4.2**, a Telegram bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram user ID, and an **OpenAI or Google AI API key**.

```bash
git clone https://github.com/mio-gato-software/mgsbot.git
cd mgsbot
bun install --frozen-lockfile
cp .env.sample .env
```

Fill in `.env` for an OpenAI-only setup:

```dotenv
BOT_TOKEN=your_telegram_bot_token
OWNER_USER_ID=your_numeric_telegram_user_id
OPENAI_API_KEY=your_openai_api_key
AI_PLATFORM=openai
```

For Gemini, use `GOOGLE_API_KEY` and `AI_PLATFORM=gemini` instead. OpenAI alone covers most features; **YouTube analysis requires Google**.

```bash
bun run start
```

DM the bot to configure its name, language, and personality, or use the [profile files](#profile-rules-and-character-image). On a computer with a browser, `bun run start -- --setup` opens the configuration wizard; missing credentials also trigger it. Prepare `.env` beforehand on a server or in Docker.

## Configuration

[`.env.sample`](.env.sample) lists credentials, model variables, defaults, and optional settings. Restart after editing `.env`.

`OWNER_USER_ID` permits the owner's DMs; `ALLOWED_GROUP_ID` optionally permits one group. The group router supports direct mentions, replies, natural continuations, and spontaneous responses. Unaddressed messages can contribute to memory; `ENABLE_GROUP_VOICE_CONTEXT=false` disables passive voice-note transcription.

`AI_PLATFORM` supplies defaults: Gemini when a Google key exists, otherwise OpenAI. Services are independently configurable:

| Service | Setting |
| --- | --- |
| Conversation | `CHAT_PROVIDER` and its model variable |
| Transcription / voice replies | `STT_PROVIDER` / `TTS_PROVIDER` |
| Image generation | `IMAGE_PROVIDER` and its model variable |
| Memory embeddings | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIM` |
| Background memory work | `BACKGROUND_PROVIDER`, `BACKGROUND_MODEL` |
| Image / PDF analysis | `VISION_PROVIDER` / `DOCUMENT_PROVIDER` |
| Routing classifiers | `CLASSIFIER_PROVIDER`, `CLASSIFIER_MODEL`; optional TypeSafe/Jev |

Chat providers: `gemini`, `openai`, `openrouter`, `anthropic`, `azure`, `alibaba`, `fireworks`, `deepseek`, and `fal`. Keep an OpenAI or Google key for support services when using another chat provider. `BACKGROUND_FALLBACK_TO_CHAT=false` prevents background failures from invoking the chat model.

`BOT_TIMEZONE` controls the clock and schedules. Sleep hours suppress group replies and proactive sends. Follow-ups and check-ins are disabled by default; enable them with `ENABLE_FOLLOW_UPS` and `ENABLE_CHECK_INS`. Other modes include `ENABLE_TUTOR_MODE`, `SIMPLE_ASSISTANT_MODE`, and optional chat logging. See [adaptive personality](docs/adaptive-personality.md) for its controls and limits.

## Profile, rules, and character image

To configure the persona without the Telegram setup conversation:

```bash
bun run profile:init
bun run rules:init
# Edit memory/bot_profile.json and memory/bot_rules.json, then start normally.
```

A valid profile overrides in-chat configuration. Rules customize conversational behavior and style; access control and provider settings remain in `.env`. Inspect files with `bun run profile:show` and `bun run rules:show`.

Place the character reference at `memory/base.png`, `memory/base.jpg`, or `memory/base.jpeg`. Character photos always require this reference and preserve its photographic or illustrated medium. The normal weekly photo becomes eligible during a conversation; `/allowphotorequest` grants one requested photo. `FULL_ACCESS_MODE=true` enables on-demand generation, including external subjects without a character reference.

User-image edits use the user's photo; character photos use the configured reference. Photo follow-ups can reuse the sender's latest image within the recent-message buffer for up to 30 minutes; otherwise reply to the original photo. These paths use `MEMORY_DIR` when configured.

## Agenda and research

Ask naturally for one-time reminders, daily/weekly research, selected weekdays, or lasting source/style preferences. Recurrences last at most **one calendar month** and require explicit renewal. `ENABLE_COMMITMENTS=false` or simple assistant mode disables the agenda.

Reports can include requested images and conditional text/images based on confirmed research evidence. Conditions are checked after the parent report, at its scheduled cadence. Saved receipts prevent automatic replay of sent or uncertain deliveries. See [agenda and standing preferences](docs/agenda-and-preferences.md) for examples, permissions, budgets, and headless configuration.

- **Search:** `BRAVE_API_KEY` enables public search and optional ambient headlines.
- **Page reading:** works directly without extra credentials. `BROWSERBASE_API_KEY` adds Fetch and JavaScript rendering; a separately installed [local Chromium browser](docs/local-browser.md) is another option. Reads are bounded, public, and read-only.
- **Weather:** Open-Meteo needs no extra key. Configure `WEATHER_CITY` and optionally `WEATHER_COUNTRY` separately from the timezone. See [weather queries](docs/weather.md) for forecast limits and scheduled reports.

## Telegram commands

Send commands in the owner's DM.

| Command | Action |
| --- | --- |
| `/help` | List commands |
| `/provider [name] [model]` | Inspect configuration or change chat until restart; other services stay independently configured |
| `/allowphotorequest [group]` | Authorize one photo request in the DM or allowed group |
| `/off` / `/on` | Disable / enable responses without stopping the process |
| `/optimize` | Check memory-confidence decay and report statistics |

## Deployment and data

For Docker, prepare `.env` and run `docker compose up -d --build`. Compose mounts `.env` read-only and persists `memory/`, `audios/`, and `logs/`; data directories must be writable by the container's `bun` user.

For a standalone executable, use `bun run build` or `bun run build:linux`, or download a [release](https://github.com/mio-gato-software/mgsbot/releases) for Linux x64, macOS ARM64, or Windows x64. Run it from the directory containing `.env`; Bun is unnecessary on the target machine. Pushing `main` runs CI; tagged releases publish binaries. See [deployment and upgrades](docs/deployment.md).

`memory/` holds persistent user data, profiles, schedules, and recovery state. `MEMORY_DIR` changes its root; update Docker mounts accordingly. Preserve it across upgrades and use only one process per store. Verified daily backups retain seven dated snapshots; keep an external copy too. Never commit credentials or runtime data.

See [maintenance and recovery](docs/maintenance.md) for backups, corrupted stores, interrupted promotions, and embedding changes. `bun run memory:stats` reports usage and cache metrics; `bun run promote:stats` reports extraction quality. [TODO.md](TODO.md) tracks known pending work.

## Development

```bash
bun run dev          # Restart on source changes
bun run lint:fix     # Apply lint and formatting fixes
bun run typecheck    # Bun does not type-check at runtime
bun test --coverage  # Disposable test memory; enforce coverage thresholds
bun run build        # Compile the executable
```

[AGENTS.md](AGENTS.md) describes the architecture and repository rules.

## License

[MIT](LICENSE). This project is not accepting contributions; forks are welcome.
