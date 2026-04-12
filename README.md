# MGS Bot

<p align="center">
  <img src="assets/bot-avatar.jpg" alt="MGS Bot" width="300" />
  <br />
  <sub>Character image generated with Gemini from a prompt by my daughter</sub>
</p>

A conversational Telegram bot with long-term memory, emergent personality, and multi-modal capabilities. Built with [grammY](https://grammy.dev), [Google Gemini](https://ai.google.dev), and [Bun](https://bun.sh).

MGS Bot isn't a typical chatbot — it remembers conversations, develops personality traits over time, recognizes users across name changes, and proactively reaches out like a real friend. It handles text, voice notes, photos, and YouTube links out of the box.

> **Note:** This project is not currently accepting contributions. Feel free to fork it for your own use.

## Features

- **4-tier memory system** — permanent personality, semantic knowledge base with vector embeddings, per-chat episode summaries, and a sensory buffer of recent messages
- **Emergent personality** — traits evolve naturally through conversations, with momentum, decay, and periodic self-description
- **Multi-modal input** — text, voice notes, audio files, photos/images, and YouTube link analysis
- **Image generation** — generates character images using Gemini or fal.ai with an optional reference image
- **Voice responses** — text-to-speech replies via ElevenLabs, LemonFox, Inworld, or fal.ai
- **Proactive behavior** — follow-up questions about mentioned plans and periodic check-in messages
- **User identity tracking** — canonical names with alias support, handles name changes gracefully
- **Multi-provider chat** — swap between Gemini, OpenRouter, Anthropic, Azure, Alibaba, Fireworks, OpenAI, or fal.ai at runtime
- **Sleep schedule** — configurable quiet hours (default: 11:30 PM – 6:00 AM)
- **Bilingual** — setup wizard and bot personality support English and Spanish
- **English tutor mode** — natural English practice with the same bot personality, plus automatic English hints for STT
- **Full-access mode** — removes image generation limits and enables on-demand subject/self image markers, independent of tutor mode
- **Simple assistant mode** — strip all personality features for a basic helpful-assistant experience
- **Docker support** — single-command deployment with persistent volumes

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- A Telegram bot token ([get one from @BotFather](https://t.me/BotFather))
- A Google AI API key ([get one from Google AI Studio](https://aistudio.google.com/apikey))
- Your Telegram user ID ([get it from @userinfobot](https://t.me/userinfobot))

### Setup

```bash
git clone https://github.com/eliaquin/mgsbot.git
cd mgsbot
bun install
bun run start
```

On first run, a **setup wizard** opens in your browser. It walks you through:

1. Choosing the bot language (English or Spanish)
2. Entering your Telegram bot token
3. Entering your Google AI API key and choosing a model
4. Entering your Telegram user ID

The wizard writes your `.env` file automatically. After that, the bot starts and asks you (via Telegram DM) to define its name, birth year, gender, and personality.

To re-run the wizard later:

```bash
bun run start -- --setup
```

### Docker

```bash
# Create your .env file first (copy from .env.sample)
cp .env.sample .env
# Edit .env with your values, then:
docker compose up -d
```

Memory, audio files, and logs persist via volume mounts. The bot auto-creates all required directories on startup.

## Configuration

All configuration is via environment variables. Copy `.env.sample` to `.env` and fill in the values.

### Required

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `GOOGLE_API_KEY` | Google AI API key — always required, even when using a different chat provider. Used for embeddings, image analysis, YouTube analysis, image generation, and Gemini-based audio transcription when LemonFox is not used or `STT_PROVIDER=gemini`. |
| `OWNER_USER_ID` | Your Telegram user ID. The bot only responds to DMs from this user. |

### Chat Provider

| Variable | Default | Description |
| --- | --- | --- |
| `CHAT_PROVIDER` | `gemini` | Chat provider: `gemini`, `openrouter`, `anthropic`, `azure`, `alibaba`, `fireworks`, `openai`, or `fal` |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model when `CHAT_PROVIDER=gemini` (other Gemini-only paths in code use fixed models; see **Google AI usage** below) |
| `OPENROUTER_API_KEY` | — | Required if using OpenRouter |
| `OPENROUTER_MODEL` | `anthropic/claude-3.5-sonnet` | OpenRouter model |
| `ANTHROPIC_API_KEY` | — | Required if using Anthropic |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | Anthropic model |
| `AZURE_API_KEY` | — | Required if using Azure |
| `AZURE_ENDPOINT` | — | Azure endpoint URL |
| `AZURE_MODEL` | `Kimi-K2.5` | Azure model |
| `DASHSCOPE_API_KEY` | — | Required if using Alibaba |
| `DASHSCOPE_MODEL` | `qwen3.5-plus` | Alibaba DashScope model |
| `FIREWORKS_API_KEY` | — | Required if using Fireworks |
| `FIREWORKS_MODEL` | `accounts/fireworks/models/glm-5` | Fireworks model |
| `OPENAI_API_KEY` | — | Required if using OpenAI |
| `OPENAI_MODEL` | `gpt-5.4` | OpenAI model |
| `FAL_API_KEY` | — | Required if using fal.ai (chat, TTS, STT, or image generation) |
| `FAL_MODEL` | `google/gemini-2.5-pro` | fal.ai model (via OpenRouter proxy) |

#### Recommended Models

| Goal | Provider | Model | Notes |
| --- | --- | --- | --- |
| **Best compatibility** | `gemini` | `gemini-3.1-pro` | Best overall experience — native support for all features including function calling and vision |
| **Best value** | `fireworks` | `accounts/fireworks/models/kimi-k2.5` | Strong performance at low cost |

You can switch providers at runtime via the `/provider` Telegram command (DM only, owner only):

```text
/provider anthropic claude-sonnet-4-5-20250929
/provider gemini
/provider openrouter meta-llama/llama-4-scout
/provider fal google/gemini-2.5-pro
```

**Google AI usage (independent of chat provider):** Embeddings use `gemini-embedding-2-preview`. Character image generation uses `gemini-3.1-flash-image-preview`. Transcription (Gemini path), image description when falling back from a non-vision provider, and YouTube analysis use `gemini-3-flash-preview` in `src/ai.ts`.

### Access Control

| Variable | Description |
| --- | --- |
| `ALLOWED_GROUP_ID` | Telegram group ID where the bot is allowed. If unset, the bot ignores all group messages. |
| `OWNER_USER_ID` | Telegram user ID of the owner. If unset, the bot ignores all DMs. |

In groups, the bot only responds when mentioned (by reply, @tag, or name). In DMs, it responds to everything.

### Optional Services

| Variable | Default | Description |
| --- | --- | --- |
| `TTS_PROVIDER` | *(auto)* | TTS provider: `elevenlabs`, `lemonfox`, `inworld`, or `fal`. Auto-detected from available API keys if unset (fal requires explicit selection). |
| `LEMON_FOX_API_KEY` | — | Enables LemonFox TTS and audio transcription |
| `ELEVENLABS_API_KEY` | — | Enables ElevenLabs TTS |
| `ELEVENLABS_VOICE_ID` | — | ElevenLabs voice ID (default: `JBFqnCBsd6RMkjVDRZzb`) |
| `INWORLD_API_KEY` | — | Enables Inworld TTS |
| `INWORLD_VOICE_ID` | — | Inworld voice ID (required if using Inworld) |
| `FAL_VOICE` | `Sarah` | ElevenLabs voice name for fal.ai TTS (Aria, Roger, Sarah, Charlotte, Rachel) |
| `STT_PROVIDER` | *(auto)* | STT provider: `gemini`, `lemonfox` *(auto if key set)*, or `fal` (ElevenLabs Scribe v2 via fal.ai) |
| `IMAGE_PROVIDER` | `gemini` | Image generation provider: `gemini` or `fal` (nano-banana-pro via fal.ai) |
| `SHOW_TRANSCRIPTION` | `false` | Show transcription text for voice messages (both sent and received) |

### Behavior

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_TUTOR_MODE` | `false` | Enable English tutor mode. Adds a natural English-practice persona and forces STT (LemonFox/Gemini) to transcribe as English. Does not change image behavior. Env-only (no runtime toggle). |
| `FULL_ACCESS_MODE` | `false` | Remove image-generation limits: bypasses the weekly schedule, enables the `[IMAGE: ...]` subject-only and `[IMAGE_SELF: ...]` self-in-scene markers on demand, and allows baseless generation (fal.ai). Independent of tutor mode; does not affect language or STT. |
| `SIMPLE_ASSISTANT_MODE` | `false` | Disables personality, media processing, image generation, and memory. Uses a basic "helpful assistant" prompt. |
| `ENABLE_SLEEP_SCHEDULE` | `true` | Bot sleeps 11:30 PM – 6:00 AM in its configured timezone |
| `BOT_TIMEZONE` | `America/Santo_Domingo` | IANA timezone for sleep schedule, time awareness, follow-ups, and weather |
| `ENABLE_FOLLOW_UPS` | `false` | Proactive follow-up questions about plans the user mentioned |
| `ENABLE_CHECK_INS` | `false` | Proactive check-in messages (~2/week, like a real friend) |
| `CHECK_INS_PER_WEEK` | `2` | Number of check-in messages per week |
| `ENABLE_CHAT_LOG` | `false` | Daily conversation logging to `logs/` folder |
| `NODE_ENV` | `production` | Set `development` for verbose logging |

## Architecture

```text
index.ts                     Entry point: env loading, setup wizard, bot startup
src/
  ai.ts                      Gemini API: transcription (Gemini/LemonFox/fal), image description,
                              YouTube analysis, memory evaluation
  memory.ts                  4-tier memory read/write + promotion/decay logic
  prompt.ts                  System prompt assembly with context from all memory tiers
  conversation.ts            Conversation processing pipeline (prompt → generate → save → reply)
  response-processor.ts      Response marker processing and reply formatting
  handlers.ts                grammY handlers: voice, audio, photo, text, YouTube, /provider,
                              security middleware (ALLOWED_GROUP_ID + OWNER_USER_ID guard)
  embeddings.ts              Vector embeddings (gemini-embedding-2-preview) with disk-persisted LRU cache
  personality.ts             Emergent personality: trait growth, decay, momentum, AI description
  identities.ts              User identity tracking: canonical names, aliases, name changes
  check-ins.ts               Proactive check-in scheduling and delivery
  follow-ups.ts              Follow-up detection, scheduling, and delivery
  config.ts                  Bot configuration state (name, birth year, setup status)
  setup.ts                   In-Telegram personality setup conversation (4-step)
  wizard.ts                  Browser-based setup wizard (env + API keys)
  bot-time.ts                Centralized timezone utilities (dayjs)
  holidays.ts                Holiday calendar (currently Dominican Republic 2026)
  daily-weather.ts           Weather data from Open-Meteo API, cached daily
  chat-logger.ts             Daily conversation log writer
  tutor.ts                   English tutor mode: state toggle and prompt instructions
  full-access.ts             Full-access mode: removes image limits, enables subject/self image markers
  appearance.ts              Base character image locator for image generation
  image-scheduler.ts         Weekly character image generation schedule
  media-handlers.ts          Audio/image download and processing
  utils.ts                   Atomic file writes
  types.ts                   TypeScript interfaces for all data structures
  providers/
    types.ts                 ChatProvider interface and ChatMessage type
    index.ts                 Provider factory and runtime switching
    gemini.ts                Gemini provider (with weather function calling)
    openrouter.ts            OpenRouter provider
    anthropic.ts             Anthropic provider
    azure.ts                 Azure OpenAI provider
    alibaba.ts               Alibaba DashScope provider
    fireworks.ts             Fireworks AI provider
    openai.ts                OpenAI provider
    fal.ts                   fal.ai provider (OpenRouter proxy)
  tts/
    types.ts                 TTS provider interface
    index.ts                 TTS provider factory and selection
    elevenlabs.ts            ElevenLabs TTS provider
    lemonfox.ts              LemonFox TTS provider
    inworld.ts               Inworld TTS provider
    fal.ts                   fal.ai TTS provider (ElevenLabs via fal.ai)
  image/
    types.ts                 ImageProvider interface
    index.ts                 Image provider factory and selection
    gemini.ts                Gemini image generation (character images)
    fal.ts                   fal.ai image generation (nano-banana-pro)
```

### Memory System

The bot uses a 4-tier memory architecture inspired by human cognition:

```text
┌─────────────────────────────────────────────────┐
│  Permanent Memory (memory/permanent.md)         │
│  Bot personality and rules. Auto-generated      │
│  during setup. Cached with 1-minute refresh.    │
├─────────────────────────────────────────────────┤
│  Semantic Store (memory/semantic.json)           │
│  Global knowledge base of atomic facts with     │
│  vector embeddings (gemini-embedding-2-preview). │
│  Categories: person, group, rule, event.        │
│  Confidence decays 0.02/day (min 0.1).          │
│  Deduplication via cosine similarity at 0.85.   │
├─────────────────────────────────────────────────┤
│  Episodes (memory/episodes/<chat_id>.json)      │
│  Per-chat summarized conversations (max 20).    │
│  Each has summary, participants, importance,    │
│  and an embedding for similarity search.        │
│  Top 3 most relevant selected per prompt.       │
├─────────────────────────────────────────────────┤
│  Sensory Buffer (memory/sensory/<chat_id>.json) │
│  Recent messages per chat (max 10, FIFO).       │
│  Oldest 5 promoted to episode via AI            │
│  summarization on overflow. Inactive chats      │
│  (>3 days) clear messages but keep summary.     │
└─────────────────────────────────────────────────┘
```

All memory files are auto-created on first run. The `memory/` directory is gitignored — it contains your bot's learned knowledge and should be treated as user data.

### Personality System

The bot develops emergent personality traits that evolve over time:

- **Traits** are key-value pairs with values between 0.0 and 1.0, plus momentum and a last-reinforced timestamp
- Traits **decay** toward neutral (0.5) at 0.005/day — unused traits fade naturally
- Inactive neutral traits are **pruned** after 14 days (max 15 traits)
- Every 10 evaluations, the AI generates a personality **self-description** (100–150 words)
- Growth events record what caused each trait change

### Conversation Flow

1. Security middleware checks `ALLOWED_GROUP_ID` / `OWNER_USER_ID`
2. If not configured, enter the interactive personality setup
3. Load sensory buffer; register/update user identity
4. In groups: detect mention type (reply / @tag / name / none) — only respond when mentioned
5. Assemble system prompt: permanent personality + personality description + relevant semantic facts + relevant episodes + sensory messages + time/activity context
6. Call the active chat provider, save the exchange, reply with Markdown (falls back to plain text)
7. Special response markers:
   - `[SILENCE]` — no response
   - `[REACT:emoji]` — react with an emoji instead of replying
   - `[IMAGE: prompt]` — generate and send a character image
   - `[TTS]text[/TTS]` — send a voice note via the configured TTS provider
8. Background: memory evaluation extracts semantic facts, personality signals, and follow-up opportunities

### Image Generation

The bot generates character images on a weekly schedule:

- One random day per week, at a random time between 8 AM and 11 PM (bot timezone)
- Pluggable provider: Gemini (`IMAGE_PROVIDER=gemini`, default) or fal.ai (`IMAGE_PROVIDER=fal`)
- Gemini uses `gemini-3.1-flash-image-preview` with a base character image (`memory/base.{png,jpg,jpeg}`)
- fal.ai uses nano-banana-pro: `/edit` endpoint when a base image exists (character images), base endpoint for standalone generation (e.g., full-access mode illustrations)
- Schedule tracked per-chat via sensory buffer fields (`lastImageDate`, `imageTargetDate`, `imageTargetTime`)
- On-demand photo requests gated by `allowPhotoRequest` flag (toggled via `/allowphotorequest` command)
- In full-access mode, the weekly schedule limit is removed — images generate whenever the bot judges them useful, with `[IMAGE: ...]` for subject-only and `[IMAGE_SELF: ...]` for self-in-scene

### Proactive Features

**Follow-ups** (`ENABLE_FOLLOW_UPS=true`): The bot detects planned events or activities mentioned in conversation and schedules follow-up questions. For example, if you mention going to a movie tonight, it might ask "How was the movie?" tomorrow. Rate limited to 2 sends/day with a 2-hour cooldown. Expires after 3 days. Cancelled if you already mentioned the topic.

**Check-ins** (`ENABLE_CHECK_INS=true`): Cadence-driven proactive messages — the bot reaches out ~2 times/week to chat like a real friend. Weekly slots are scheduled on Mondays with a minimum 2-day gap. Time slots favor morning (10–12) and evening (17–20) windows. Check-in strategies rotate: `random_thought`, `memory_callback`, `sharing_moment`, `reaction`, `weather_vibe`, `curiosity`.

Both features respect the sleep schedule, won't interrupt active conversations (15-minute cooldown), and are timezone-aware.

## Commands

### Development

```bash
bun install          # Install dependencies
bun run start        # Run the bot
bun run dev          # Run with watch mode (auto-restart on changes)
bun run test         # Run tests
bun run lint         # Check lint + format issues
bun run lint:fix     # Auto-fix lint + format issues
bun run format       # Format only (Biome)
bun run build        # Compile to standalone binary
bun run build:linux  # Cross-compile for Linux x64
```

Tests live in `tests/` and cover handlers, memory, and utility logic.

### Telegram Commands

| Command | Scope | Description |
| --- | --- | --- |
| `/help` | DM only | Show available commands |
| `/provider [name] [model]` | DM only | View or switch the active chat provider; optional second argument sets the model for that session (until restart) |
| `/allowphotorequest` | DM only | Toggle on-demand photo request permission |
| `/on` | DM only | Re-enable bot responses |
| `/off` | DM only | Disable bot responses |
| `/optimize` | DM only | Run confidence decay on semantic memory |

### Maintenance Scripts

```bash
bun run scripts/migrate-memory.ts      # Migrate from old memory format (long-term.json, members.json)
bun run scripts/reembed-memory.ts      # Re-generate all vector embeddings
bun run scripts/merge-person-facts.ts  # Deduplicate person facts across name variants
```

## Customization

### Holidays

The holiday calendar in `src/holidays.ts` is currently hardcoded for Dominican Republic 2026. To customize:

1. Edit the `HOLIDAYS_2026` array with your country's holidays (month is 0-indexed)
2. Rename the variable to match the year
3. Update the `isHoliday()` function if needed

This needs to be updated annually.

### Timezone

Set `BOT_TIMEZONE` to any [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g., `America/New_York`, `Europe/London`, `Asia/Tokyo`). This affects the sleep schedule, time awareness in prompts, follow-up/check-in scheduling, and weather data.

### Character Image

Place a reference image at `memory/base.png` (or `.jpg`/`.jpeg`). The bot uses this as a visual reference when generating character images. With Gemini, the reference is required. With fal.ai, the reference is optional — without it, the bot generates standalone images (useful in full-access mode for illustrations).

### Language

The bot's conversational language is configured during setup and stored in `memory/permanent.md`. The setup wizard and in-Telegram personality setup both support English and Spanish. The bot adapts to the user's language naturally.

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Bot framework:** [grammY](https://grammy.dev)
- **AI:** [Google GenAI](https://ai.google.dev) — default chat: `gemini-3-flash-preview`; character images: `gemini-3.1-flash-image-preview`; embeddings: `gemini-embedding-2-preview`
- **Language:** TypeScript (strict mode)
- **Linter/Formatter:** [Biome](https://biomejs.dev) — tabs, double quotes, auto-organized imports

## License

[MIT](LICENSE)
