# MGS Bot

<p align="center">
  <img src="assets/bot-avatar.png" alt="MGS Bot" width="300" />
</p>

A Telegram bot with persistent conversation memory, an evolving personality, voice replies, and image generation. Built with Bun, TypeScript, and grammY.

Supports text, `.txt` files, voice notes, audio, images, PDFs, public web pages, and YouTube links. It runs for one owner in DMs and, optionally, one allowed group. Follow-ups and periodic check-ins are opt-in.

## Quick start

For running from source, use **Bun 1.3.14** (the version pinned in CI and Docker). You also need a Telegram bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram user ID, and an **OpenAI or Google AI API key**.

```bash
git clone https://github.com/eliaquin/mgsbot.git
cd mgsbot
bun install --frozen-lockfile
cp .env.sample .env
```

Edit `.env`. For an OpenAI-only setup, fill in:

```dotenv
BOT_TOKEN=your_telegram_bot_token
OWNER_USER_ID=your_numeric_telegram_user_id
OPENAI_API_KEY=your_openai_api_key
AI_PLATFORM=openai
```

For Gemini, use `GOOGLE_API_KEY` and `AI_PLATFORM=gemini` instead. OpenAI alone covers chat, memory, transcription, voice replies, images, and PDF analysis; **YouTube analysis requires Google**.

```bash
bun run start
```

Send the bot a DM to configure its name, language, and personality. To configure these from files instead, use the [profile commands](#profile-rules-and-character-image) below.

On a computer with a browser, `bun run start -- --setup` opens the configuration wizard. It also opens automatically when the bot token or both AI keys are missing. For a server or Docker deployment, prepare `.env` before starting.

## Configuration

[`.env.sample`](.env.sample) documents provider credentials, model variables, and optional settings. Restart the bot after changing `.env`.

### Access and groups

- `OWNER_USER_ID` authorizes the owner’s DMs. Without it, normal DM conversations are unavailable.
- `ALLOWED_GROUP_ID` authorizes one group. Other groups are rejected; leave it unset for DM-only use.
- In the allowed group, the bot responds to replies, tags, or its name. It can also continue a conversation or reply spontaneously when the group router allows it. Messages it receives without being addressed can contribute to memory.
- `ENABLE_GROUP_VOICE_CONTEXT=false` disables transcription of passive group voice notes. Direct mentions and voice replies remain eligible for transcription.

### Providers

`AI_PLATFORM` sets the default chat and support platform. When unset, it selects Gemini if a Google key exists, otherwise OpenAI. Each service can be configured independently:

| Service | Setting |
| --- | --- |
| Conversation | `CHAT_PROVIDER` and the provider’s model variable |
| Transcription | `STT_PROVIDER` |
| Voice replies | `TTS_PROVIDER` |
| Image generation | `IMAGE_PROVIDER` |
| Memory embeddings | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIM` |
| Background memory work | `BACKGROUND_PROVIDER`, `BACKGROUND_MODEL` |
| Image / PDF analysis | `VISION_PROVIDER`, `DOCUMENT_PROVIDER` |
| Routing classifiers | `CLASSIFIER_PROVIDER`, `CLASSIFIER_MODEL` |

Chat supports `gemini`, `openai`, `openrouter`, `anthropic`, `azure`, `alibaba`, `fireworks`, `deepseek`, and `fal`. Keep an OpenAI or Google key configured for support services even when using another chat provider.

Use `/provider` in an owner DM to inspect the active configuration, or `/provider <name> [model]` to change chat until restart. This does not change transcription, voice, images, or background memory work. For a persistent change, edit `.env`.

OpenRouter can also use fal.ai: set `CHAT_PROVIDER=openrouter`, `OPENROUTER_TRANSPORT=fal`, `FAL_API_KEY`, and `OPENROUTER_MODEL`.

### Behavior

| Setting | Default | Purpose |
| --- | --- | --- |
| `BOT_TIMEZONE` | `America/Santo_Domingo` | Time awareness and scheduling |
| `ENABLE_SLEEP_SCHEDULE` | `true` | Quiet hours, 23:30–06:00; suppresses group replies and proactive messages |
| `ENABLE_FOLLOW_UPS` | `false` | DM follow-ups about plans mentioned in conversation |
| `ENABLE_CHECK_INS` | `false` | Periodic DM check-ins; `CHECK_INS_PER_WEEK` defaults to `2` |
| `SIMPLE_ASSISTANT_MODE` | `false` | Basic assistant prompt with multimedia processing disabled |
| `ENABLE_TUTOR_MODE` | `false` | English practice and English transcription guidance |
| `FULL_ACCESS_MODE` | `false` | On-demand images without the weekly limit; does not change access control |
| `ENABLE_CHAT_LOG` | `false` | Daily text logs in `logs/`; `CHAT_LOG_RETENTION_DAYS` defaults to `30` |

Weather context defaults to Santo Domingo. Set `WEATHER_LATITUDE`, `WEATHER_LONGITUDE`, and `WEATHER_CITY` for another location.

## Profile, rules, and character image

To configure the bot without the Telegram setup conversation:

```bash
bun run profile:init
# Edit memory/bot_profile.json: name, birth year, gender, language, personality.
bun run profile:show
bun run start
```

A valid `bot_profile.json` takes precedence over the in-chat configuration. For custom behavior and style, run `bun run rules:init`, edit `memory/bot_rules.json`, and inspect it with `bun run rules:show`. Rules affect the conversation prompt; they do not override access control or provider configuration.

Place a character reference at `memory/base.png`, `memory/base.jpg`, or `memory/base.jpeg` to enable scheduled character images. `/allowphotorequest` authorizes one on-demand photo; add `group` to target the allowed group. `FULL_ACCESS_MODE=true` also permits generation without a reference.

These paths use `MEMORY_DIR` when set.

## Telegram commands

All commands are sent through the owner’s DM.

| Command | Action |
| --- | --- |
| `/help` | List commands |
| `/provider [name] [model]` | Inspect or change the chat provider for this session |
| `/allowphotorequest [group]` | Authorize one photo request in the DM or allowed group |
| `/off` / `/on` | Disable / enable responses without stopping the process |
| `/optimize` | Run the daily memory-confidence decay check and report statistics |

## Deployment

### Docker

Prepare `.env` as described above, then run:

```bash
docker compose up -d --build
docker compose logs -f bot
```

Compose mounts `.env` read-only and persists `memory/`, `audios/`, and `logs/` on the host. Those directories must be writable by the container’s `bun` user. If you change `MEMORY_DIR`, update the volume mapping too.

### Standalone executable

Build with `bun run build` (current platform) or `bun run build:linux` (Linux x64). Both produce `./mgsbot`. Prebuilt binaries are published through [GitHub Releases](https://github.com/eliaquin/mgsbot/releases).

Run the executable from a directory containing `.env`; relative data paths are resolved from the working directory. Bun is not required on the target machine.

```bash
./mgsbot --init-profile
# Edit memory/bot_profile.json.
./mgsbot --show-profile
./mgsbot --init-rules    # Optional custom rules
./mgsbot --help         # All configuration helpers
./mgsbot
```

## Data and maintenance

`memory/` contains learned facts, conversation summaries, recent messages, identities, personality, schedules, and promotion recovery data. Set `MEMORY_DIR` to use a different root. This is persistent user data: keep it across upgrades and run only one bot process against it.

- **Backups:** verified daily snapshots live in `memory/backups/`, with seven dated snapshots retained. Startup awaits a verified snapshot before memory migrations. Keep an external copy as well; local snapshots share the runtime disk.
- **Recovery:** malformed stores are preserved and writes fail instead of replacing them with empty data. Interrupted promotions retry from saved checkpoints; after ten failures, the chunk stays available for operator recovery.
- **Routine work:** confidence decay and the memory janitor run automatically. `bun run promote:stats` reports promotion decisions and extraction quality.
- **Embedding changes:** startup rebuilds stale vectors when the embedding provider, model, or dimensions change. `AUTO_REEMBED=false` disables this; `bun run scripts/reembed-memory.ts` forces a rebuild. Stop the bot and preserve a backup before running a manual rewrite.

See [maintenance and recovery](docs/maintenance.md) for restoration and failed-promotion procedures, and [TODO.md](TODO.md) for pending operational checks.

## Development

```bash
bun run dev          # Restart on source changes
bun run lint:fix     # Apply lint and formatting fixes
bun run typecheck    # Check TypeScript; Bun does not type-check at runtime
bun test --coverage  # Run tests and enforce coverage thresholds
bun run build        # Compile the executable
```

Tests use a disposable memory directory, including when `MEMORY_DIR` is inherited, and inject external services for conversation and recovery tests.

For navigation: `index.ts` owns startup and shutdown; `src/handlers/` handles incoming media and routing; `src/conversation.ts` coordinates turns; `src/prompt/`, `src/memory/`, and `src/providers/` contain prompt assembly, persistence, and chat adapters. Voice and image adapters live in `src/stt/`, `src/tts/`, and `src/image/`. The detailed repository guide is in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). This project is not accepting contributions; forks are welcome.
