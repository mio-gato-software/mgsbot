# MGS Bot

<p align="center">
  <img src="assets/bot-avatar.jpg" alt="MGS Bot" width="300" />
  <br />
  <sub>Character image generated with Gemini from a prompt by my daughter</sub>
</p>

A conversational Telegram bot with long-term memory, emergent personality, and multi-modal capabilities. Built with [grammY](https://grammy.dev), [OpenAI](https://platform.openai.com) or [Google Gemini](https://ai.google.dev), and [Bun](https://bun.sh).

MGS Bot isn't a typical chatbot — it remembers conversations across several layers, develops personality traits over time, recognizes users across name changes, and proactively reaches out like a real friend. It handles text, voice notes, photos, PDFs, public web pages, and YouTube links out of the box, while still supporting a simpler assistant mode when you do not want the personality system.

> **Note:** This project is not currently accepting contributions. Feel free to fork it for your own use.

## Features

- **Layered memory system** — manual profile/rules, relationship summaries, monthly chapters, semantic facts, episode summaries, and recent sensory context
- **Self-maintaining memory** — failed promotions are spooled and retried (no data loss on API errors), often-recalled facts decay more slowly (capped so repetition never reads as certainty), and a daily janitor retires contradicted or duplicate facts
- **Emergent personality** — traits evolve naturally through conversations, with momentum, decay, and periodic self-description
- **Multi-modal input** — text, voice notes, audio files, photos/images, PDFs (including scans, embedded images, charts, and tables), public web pages, and YouTube link analysis
- **Image generation** — generates character images using OpenAI, Gemini, or fal.ai with an optional reference image
- **Voice responses** — text-to-speech replies via ElevenLabs, LemonFox, Inworld, OpenAI, or fal.ai
- **Proactive behavior** — follow-up questions about mentioned plans and periodic check-in messages
- **User identity tracking** — canonical names with alias support, handles name changes gracefully
- **Multi-provider chat** — swap between Gemini, OpenRouter, Anthropic, Azure, Alibaba, Fireworks, OpenAI, DeepSeek, or fal.ai at runtime
- **Headless VPS configuration** — manage personality and conversational rules from JSON files using the compiled executable
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

#### Headless personality setup

If you are deploying only the compiled executable on a VPS, you can configure the bot personality without the browser wizard or Telegram setup conversation:

```bash
./mgsbot --init-profile
nano memory/bot_profile.json
./mgsbot
```

If `memory/bot_profile.json` exists and contains the required fields, it is used as the active personality profile and the bot is considered configured.

Useful executable commands:

```bash
./mgsbot --help
./mgsbot --show-profile
./mgsbot --sync-profile
./mgsbot --init-profile --force
```

You can also customize conversational rules without source code:

```bash
./mgsbot --init-rules
nano memory/bot_rules.json
./mgsbot --show-rules
```

`memory/bot_rules.json` is optional. It can add custom behavior, style, relationship, group, and new-person rules. It cannot override technical/security behavior such as access control, provider configuration, or marker syntax.

The same helpers are available during development:

```bash
bun run profile:init
bun run profile:show
bun run profile:sync
bun run rules:init
bun run rules:show
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

There are independent provider axes. `AI_PLATFORM` (`gemini` or `openai`) sets the default for chat and support work when a more specific provider is unset. With only `OPENAI_API_KEY`, the bot defaults to OpenAI for almost everything.

| Axis | Env var | Controls | Default / fallback | Shared keys |
| --- | --- | --- | --- | --- |
| Chat | `CHAT_PROVIDER` | Main conversation replies and `/provider` runtime switching | `gemini` if Google is set, else `openai` | Provider-specific chat key |
| Speech-to-text | `STT_PROVIDER` | Voice/audio transcription | platform key -> `fal` -> `lemonfox` | `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `FAL_API_KEY`, or `LEMON_FOX_API_KEY` |
| Text-to-speech | `TTS_PROVIDER` | `[TTS]...[/TTS]` and random voice replies | `elevenlabs` -> `inworld` -> `lemonfox` -> `openai`; `fal` only when explicit | `ELEVENLABS_API_KEY`, `INWORLD_API_KEY`, `LEMON_FOX_API_KEY`, `OPENAI_API_KEY`, or `FAL_API_KEY` |
| Images | `IMAGE_PROVIDER` + model env | Character image generation/editing | `openai` or `gemini` from `AI_PLATFORM`; fal defaults to `nano-banana-pro` | `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or `FAL_API_KEY` |
| Embeddings | `EMBEDDING_PROVIDER` | Memory search / dedup | `AI_PLATFORM` | `OPENAI_API_KEY` or `GOOGLE_API_KEY` |
| Background | `BACKGROUND_PROVIDER` | Fact extraction, narrative, janitor | `AI_PLATFORM` | Same as embeddings |

`/provider` only changes the chat axis. It does not change transcription, voice replies, image generation, embeddings, YouTube analysis, or fallback image analysis. Background memory work uses `BACKGROUND_MODEL` on the configured background provider so an expensive chat model doesn't multiply background costs.

### Required

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `OPENAI_API_KEY` or `GOOGLE_API_KEY` | At least one AI key. OpenAI alone covers chat, embeddings, STT, TTS, images, PDFs, classifiers, and background work. Google remains optional and is still required for YouTube analysis and Gemini-specific models. |
| `OWNER_USER_ID` | Your Telegram user ID. The bot only responds to DMs from this user. |

### Chat Provider

| Variable | Default | Description |
| --- | --- | --- |
| `AI_PLATFORM` | *(auto)* | Default platform for chat + support work: `gemini` or `openai`. Auto-selects `openai` when only `OPENAI_API_KEY` is set. |
| `CHAT_PROVIDER` | *(auto)* | Chat provider: `gemini`, `openai`, `openrouter`, `anthropic`, `azure`, `alibaba`, `fireworks`, `deepseek`, or `fal` |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Gemini chat model when `CHAT_PROVIDER=gemini` |
| `GEMINI_IMAGE_MODEL` | `gemini-3-pro-image` | Gemini image generation model (`IMAGE_PROVIDER=gemini`) |
| `BACKGROUND_MODEL` | platform default | Pinned model for background memory work — fact extraction, narrative updates, and the memory janitor. Defaults to `gpt-5.6-luna` on OpenAI or `gemini-3.6-flash` on Gemini. |
| `OPENROUTER_API_KEY` | — | Required if using OpenRouter direct transport |
| `OPENROUTER_MODEL` | `anthropic/claude-3.5-sonnet` | OpenRouter model |
| `OPENROUTER_TRANSPORT` | *(auto)* | `direct` uses `OPENROUTER_API_KEY`; `fal` uses `FAL_API_KEY` with fal.ai's `openrouter/router` endpoint. If unset, direct is used when `OPENROUTER_API_KEY` exists; otherwise fal is used when `FAL_API_KEY` exists. |
| `ANTHROPIC_API_KEY` | — | Required if using Anthropic |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | Anthropic model |
| `AZURE_API_KEY` | — | Required if using Azure |
| `AZURE_ENDPOINT` | — | Azure endpoint URL |
| `AZURE_MODEL` | `Kimi-K2.5` | Azure model |
| `DASHSCOPE_API_KEY` | — | Required if using Alibaba |
| `DASHSCOPE_MODEL` | `qwen3.5-plus` | Alibaba DashScope model |
| `FIREWORKS_API_KEY` | — | Required if using Fireworks |
| `FIREWORKS_MODEL` | `accounts/fireworks/models/glm-5` | Fireworks model |
| `OPENAI_API_KEY` | — | Required for OpenAI chat/support. Enough on its own for most of the bot. |
| `OPENAI_MODEL` | `gpt-5.6-luna` | OpenAI chat model (GPT-5.6 cheap tier) |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | OpenAI image generation model (`IMAGE_PROVIDER=openai`) |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | OpenAI transcription model |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI speech model |
| `DEEPSEEK_API_KEY` | — | Required if using DeepSeek |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | DeepSeek model |
| `FAL_API_KEY` | — | Required if using fal.ai for chat, OpenRouter via fal, TTS, STT, or image generation |
| `FAL_MODEL` | `google/gemini-2.5-pro` | fal.ai model (via OpenRouter proxy) |

#### Recommended Models

| Goal | Provider | Model | Notes |
| --- | --- | --- | --- |
| **OpenAI-only** | `openai` | `gpt-5.6-luna` | Cheap GPT-5.6 tier; one key covers chat, memory, STT, TTS, images, and PDFs |
| **Best Gemini compatibility** | `gemini` | `gemini-3.1-pro-preview` | Native support including YouTube analysis |
| **Best value (other)** | `fireworks` | `accounts/fireworks/models/kimi-k2.5` | Strong performance at low cost |

You can switch providers at runtime via the `/provider` Telegram command (DM only, owner only):

```text
/provider anthropic claude-sonnet-4-5-20250929
/provider gemini
/provider openrouter meta-llama/llama-4-scout
/provider openrouter anthropic/claude-sonnet-4.6
/provider deepseek deepseek-v4-pro
/provider fal google/gemini-2.5-pro
```

**OpenRouter via fal.ai:** Set `CHAT_PROVIDER=openrouter`, `OPENROUTER_TRANSPORT=fal`, `FAL_API_KEY`, and `OPENROUTER_MODEL=<provider/model>` to use fal.ai's OpenRouter gateway without a separate OpenRouter key. If `OPENROUTER_TRANSPORT` is unset and `OPENROUTER_API_KEY` is missing, the bot automatically uses the fal transport when `FAL_API_KEY` is available.

**Provider combinations:** You can mix providers across axes. For example, `CHAT_PROVIDER=openai`, `STT_PROVIDER=openai`, `TTS_PROVIDER=openai`, and `IMAGE_PROVIDER=openai` is a complete OpenAI-only stack. Mixing still works: `CHAT_PROVIDER=anthropic`, `STT_PROVIDER=gemini`, `TTS_PROVIDER=elevenlabs`, and `IMAGE_PROVIDER=fal` is valid as long as the matching keys are set.

**OpenAI-only usage:** set `OPENAI_API_KEY` (and optionally `AI_PLATFORM=openai`). Defaults: chat/background/classifiers/vision/documents `gpt-5.6-luna`, embeddings `text-embedding-3-small` (768-d), STT `gpt-4o-mini-transcribe`, TTS `gpt-4o-mini-tts`, images `gpt-image-2`. YouTube analysis remains Gemini-only.

**Google AI usage:** Embeddings use `gemini-embedding-2`. Character image generation uses `GEMINI_IMAGE_MODEL` (default `gemini-3-pro-image`). Transcription, image/PDF analysis, and YouTube analysis use the matching `GEMINI_*_MODEL` vars (default `gemini-3.6-flash`).

### Access Control

| Variable | Description |
| --- | --- |
| `ALLOWED_GROUP_ID` | Telegram group ID where the bot is allowed. If unset, the bot ignores all group messages. |
| `OWNER_USER_ID` | Telegram user ID of the owner. If unset, the bot ignores all DMs. |

In groups, the bot only responds when mentioned (by reply, @tag, or name). In DMs, it responds to everything.

### Optional Services

| Variable | Default | Description |
| --- | --- | --- |
| `TTS_PROVIDER` | *(auto)* | TTS provider: `elevenlabs`, `lemonfox`, `inworld`, `openai`, or `fal`. Auto-detected from available API keys if unset (fal requires explicit selection). |
| `LEMON_FOX_API_KEY` | — | Enables LemonFox TTS and audio transcription |
| `ELEVENLABS_API_KEY` | — | Enables ElevenLabs TTS |
| `ELEVENLABS_VOICE_ID` | — | ElevenLabs voice ID (default: `JBFqnCBsd6RMkjVDRZzb`) |
| `INWORLD_API_KEY` | — | Enables Inworld TTS |
| `INWORLD_VOICE_ID` | — | Inworld voice ID (required if using Inworld) |
| `FAL_VOICE` | `Sarah` | ElevenLabs voice name for fal.ai TTS (Aria, Roger, Sarah, Charlotte, Rachel) |
| `STT_PROVIDER` | *(auto)* | STT provider: `gemini`, `openai`, `lemonfox`, or `fal` |
| `ENABLE_GROUP_VOICE_CONTEXT` | `true` | Transcribe passive group voice notes for memory/context. Set to `false` to return to placeholder-only observation. |
| `GROUP_PASSIVE_VOICE_MAX_SECONDS` | `120` | Maximum duration for passive group voice-note transcription. Direct replies/mentions are still transcribed. |
| `GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS` | `1200` | Maximum transcript characters stored for passive group voice context. |
| `IMAGE_PROVIDER` | *(auto)* | Image generation provider: `gemini`, `openai`, or `fal` |
| `FAL_IMAGE_MODEL` | `nano-banana-pro` | fal.ai image model: `nano-banana-pro` or `gpt-image-2` |
| `FAL_IMAGE_QUALITY` | `high` | fal.ai GPT Image 2 quality: `low`, `medium`, or `high` |
| `FAL_IMAGE_TIMEOUT_MS` | `300000` | fal.ai generation timeout in milliseconds |
| `SHOW_TRANSCRIPTION` | `false` | Show transcription text for voice messages (both sent and received) |

### Behavior

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_TUTOR_MODE` | `false` | Enable English tutor mode. Adds a natural English-practice persona and forces STT (LemonFox/Gemini) to transcribe as English. Does not change image behavior. Env-only (no runtime toggle). |
| `FULL_ACCESS_MODE` | `false` | Remove image-generation limits: bypasses the weekly schedule, enables the `[IMAGE: ...]` subject-only and `[IMAGE_SELF: ...]` self-in-scene markers on demand, and allows baseless generation (fal.ai). Independent of tutor mode; does not affect language or STT. |
| `SIMPLE_ASSISTANT_MODE` | `false` | Disables personality, media processing, image generation, and memory. Uses a basic "helpful assistant" prompt. |
| `ENABLE_SLEEP_SCHEDULE` | `true` | Bot sleeps 11:30 PM – 6:00 AM in its configured timezone |
| `BOT_TIMEZONE` | `America/Santo_Domingo` | IANA timezone for sleep schedule, time awareness, follow-ups, and weather |
| `WEATHER_LATITUDE` | `18.4861` | Latitude for daily weather context (default: Santo Domingo) |
| `WEATHER_LONGITUDE` | `-69.9312` | Longitude for daily weather context (default: Santo Domingo) |
| `WEATHER_CITY` | `Santo Domingo` | City name used in the weather context string |
| `ENABLE_FOLLOW_UPS` | `false` | Proactive follow-up questions about plans the user mentioned |
| `ENABLE_CHECK_INS` | `false` | Proactive check-in messages (~2/week, like a real friend) |
| `CHECK_INS_PER_WEEK` | `2` | Number of check-in messages per week |
| `ENABLE_MEMORY_JANITOR` | `true` | Daily semantic-memory janitor that retires contradicted/duplicate facts about the same subject |
| `ENABLE_CHAT_LOG` | `false` | Daily conversation logging to `logs/` folder |
| `CHAT_LOG_RETENTION_DAYS` | `30` | Days to keep daily chat log files before deletion |
| `NODE_ENV` | `production` | Set `development` for verbose logging |

## Architecture

```text
index.ts                     Entry point: env loading, CLI helpers, setup wizard, bot startup
src/
  conversation.ts            Main turn pipeline: sensory append, retrieval, prompt, generation,
                              response sending, and background memory evaluation
  handlers.ts                grammY update handlers and access control
  commands.ts                Telegram commands: /provider, /allowphotorequest, /help, /on,
                              /off, /optimize
  response-processor.ts      Response marker handling, image/TTS sending, reply formatting
  media-handlers.ts          Telegram media download and preprocessing
  bot-state.ts               Runtime on/off state
  bot-time.ts                Centralized timezone utilities (dayjs)
  config.ts                  Bot profile/config state, permanent.md migration, headless profile
  bot-rules.ts               Optional headless behavior/style/group rule configuration
  setup.ts                   In-Telegram personality setup conversation
  wizard.ts                  Browser-based .env setup wizard
  provider-options.ts        Provider metadata, env validation, runtime status formatting
  embeddings.ts              Vector embeddings (Gemini or OpenAI) with disk-persisted LRU cache
  personality.ts             Emergent personality: trait growth, decay, momentum, AI description
  identities.ts              User identity tracking: canonical names, aliases, name changes
  check-ins.ts               Proactive check-in scheduling and delivery
  follow-ups.ts              Follow-up detection, scheduling, and delivery
  janitor.ts                 Daily semantic-memory janitor: retires contradicted/duplicate facts
  holidays.ts                Holiday calendar (currently Dominican Republic 2026)
  daily-weather.ts           Weather data from Open-Meteo API, cached daily
  chat-logger.ts             Daily conversation log writer
  appearance.ts              Base character image locator for image generation
  image-scheduler.ts         Weekly character image generation schedule
  utils.ts                   Atomic file writes
  types.ts                   TypeScript interfaces for all data structures
  ai/
    core.ts                  Chat generation + background work (Gemini or OpenAI)
    platform.ts              AI_PLATFORM + independent support-axis resolution
    vision.ts                Image and YouTube analysis helpers
    documents.ts             PDF analysis via Gemini or OpenAI
    evaluation.ts            Memory extraction, personality signals, relationship/chapter updates
    classifiers.ts           Lightweight AI classifiers used by proactive features
  memory/
    index.ts                 Memory facade and directory initialization
    sensory.ts               Recent-message buffer and boundary-aware overflow promotion
    promotion-spool.ts       Spool of unpromoted chunks (failed promotions, inactivity wipes)
    promotion-policy.ts      Promotion importance bars + the gate every chunk is judged by
    promotion-metrics.ts     Per-decision telemetry: what each bar dropped, extraction quality
    episodes.ts              Per-chat episodic summaries and relevance search
    semantic.ts              Global semantic facts, decay, retrieval reinforcement, dedup/supersession
    relationships.ts         Per-chat relationship state
    chapters.ts              Monthly narrative chapter summaries
    queries.ts               Embedding/text scoring helpers
    locks.ts                 Per-store async locks for safe file writes
  prompt/
    assemble.ts              Prompt assembly from ordered sections
    context.ts               Prompt context builder and memory/rules loading
    history.ts               Chat history construction
    modes.ts                 Simple assistant, tutor, and full-access mode flags
    pipeline.ts              Ordered prompt section registry
    sections/                Header, rules, memory, identity, activity, image, voice sections
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
    deepseek.ts              DeepSeek provider
    fal.ts                   fal.ai provider (OpenRouter proxy)
  stt/
    types.ts                 Speech-to-text provider interface
    index.ts                 STT provider order and fallback handling
    gemini.ts                Gemini transcription provider
    openai.ts                OpenAI transcription provider
    fal.ts                   fal.ai transcription provider
    lemonfox.ts              LemonFox transcription provider
  tts/
    types.ts                 TTS provider interface
    index.ts                 TTS provider factory and selection
    elevenlabs.ts            ElevenLabs TTS provider
    lemonfox.ts              LemonFox TTS provider
    inworld.ts               Inworld TTS provider
    openai.ts                OpenAI TTS provider
    fal.ts                   fal.ai TTS provider (ElevenLabs via fal.ai)
  image/
    types.ts                 ImageProvider interface
    index.ts                 Image provider factory and selection
    gemini.ts                Gemini image generation (character images)
    openai.ts                OpenAI Images API (gpt-image-2 by default)
    fal.ts                   fal.ai image generation (GPT Image 2 or Nano Banana Pro)
```

### Project Analysis

MGS Bot is organized around a retrieval-augmented conversation loop rather than a single prompt file. Each turn writes the incoming message to the sensory buffer, retrieves identity/person/relationship/chapter/semantic context, assembles an ordered system prompt, delegates generation to the active chat provider, then processes explicit response markers for silence, reactions, images, and voice notes. Longer-term memory work happens in the background so the chat path stays responsive.

The strongest architectural choice is the separation of concerns across provider axes and memory layers. Chat, STT, TTS, and image generation can be mixed independently, while the prompt pipeline decides what context is worth showing the model. This keeps cost under control by limiting retrieved facts and episodes instead of replaying raw history.

The main operational tradeoff is that the bot is file-backed. That makes the compiled executable easy to deploy on a VPS and keeps the project simple, but the runtime relies on lock helpers and atomic writes to avoid corrupting JSON stores. The current design is a good fit for a personal bot or small group. If it grows into a multi-user hosted service, the natural next step would be moving memory stores and scheduled jobs into a database-backed layer.

### Memory System

The bot uses a layered memory architecture inspired by human cognition. The top layers are manually configured identity and behavior; the lower layers are learned from conversation:

```text
┌─────────────────────────────────────────────────┐
│  Bot Profile (memory/bot_profile.json optional) │
│  Manual personality override for headless VPS   │
│  deployments. Falls back to bot_config.json.    │
├─────────────────────────────────────────────────┤
│  Bot Rules (memory/bot_rules.json optional)     │
│  Manual conversational behavior/style rules for │
│  headless VPS deployments.                      │
├─────────────────────────────────────────────────┤
│  Relationship Memory                            │
│  Per-chat relational summary and open threads   │
│  stored in memory/relationships/<chat_id>.json. │
├─────────────────────────────────────────────────┤
│  Monthly Chapters                               │
│  Per-chat narrative month summaries stored in   │
│  memory/chapters/<chat_id>.json.                │
├─────────────────────────────────────────────────┤
│  Semantic Store (memory/semantic.json)          │
│  Global knowledge base of atomic facts with     │
│  vector embeddings (gemini-embedding-2).        │
│  Categories: person, group, rule, event.        │
│  Confidence decays 0.02/day (min 0.1); facts    │
│  recalled into prompts get a small bump, capped │
│  by a ceiling that erodes as their last real    │
│  confirmation ages — decay still wins.          │
│  Deduplication via cosine similarity at 0.85.   │
│  A daily janitor retires contradicted or        │
│  duplicate facts about the same subject.        │
├─────────────────────────────────────────────────┤
│  Episodes (memory/episodes/<chat_id>.json)      │
│  Per-chat summarized conversations (max 20).    │
│  Each has summary, participants, importance,    │
│  and an embedding for similarity search.        │
│  Top 3 most relevant selected per prompt.       │
├─────────────────────────────────────────────────┤
│  Sensory Buffer (memory/sensory/<chat_id>.json) │
│  Recent messages per chat (max 10, FIFO).       │
│  On overflow the oldest 3-7 messages (split at  │
│  the largest time gap) are promoted to an       │
│  episode via AI summarization. Inactive chats   │
│  (>3 days) promote the remainder, then clear.   │
├─────────────────────────────────────────────────┤
│  Promotion Spool                                │
│  (memory/promotion-spool/<chat_id>.json)        │
│  Chunks whose promotion failed (API error, rate │
│  limit) plus inactivity-wipe remainders.        │
│  Retried at startup, hourly, and before the     │
│  chat's next promotion — nothing is lost to a   │
│  transient failure.                             │
└─────────────────────────────────────────────────┘
```

Conversations the bot merely witnesses in groups (without being addressed) are promoted only when the chunk clears a higher importance bar, so ambient chatter doesn't accumulate as long-term memory.

Both bars are env-tunable (`PROMOTION_MIN_IMPORTANCE`, `PASSIVE_PROMOTION_MIN_IMPORTANCE`) because a bar picked a priori will drop context whose value only shows up later. Every promotion decision — kept or dropped — is recorded to `memory/metrics/promotion-YYYY-MM.jsonl`, and `bun run promote:stats` replays them through the real gate at every candidate bar and reports extraction quality per model:

```bash
bun run promote:stats
```

The same report is how the background model is watched: parse failures, facts per chunk, validator-rejected facts, and empty extractions, broken down by model. An unparseable extraction is no longer silently treated as a boring conversation — it fails, the chunk goes to the retry spool, and the owner gets an alert.

All memory files are auto-created on first run. The `memory/` directory is gitignored — it contains your bot's learned knowledge and should be treated as user data.

### Personality System

The bot develops emergent personality traits that evolve over time:

- A fixed set of **8 traits** (warmth, humor, patience, curiosity, assertiveness, energy, vulnerability, playfulness), each with a value between 0.0 and 1.0, momentum, and a last-reinforced timestamp
- Background evaluation emits per-trait deltas (clamped to ±0.15); **momentum** smooths changes so the personality shifts gradually
- Each trait maps to a **tier** (low / mid / high) that selects the phrasing injected into the system prompt
- **Growth events** record what caused each trait change (last 10 kept)

### Conversation Flow

1. Security middleware checks `ALLOWED_GROUP_ID` / `OWNER_USER_ID`
2. If not configured by `memory/bot_profile.json` or `bot_config.json`, enter the interactive personality setup
3. Load sensory buffer; register/update user identity
4. In groups: detect mention type (reply / @tag / name / none) — only respond when mentioned
5. Assemble system prompt: bot profile + custom bot rules + evolving personality + relationship/chapter memory + relevant semantic facts + relevant episodes + sensory messages + time/activity context
6. Call the active chat provider, save the exchange, reply with Markdown (falls back to plain text)
7. Special response markers:
   - `[SILENCE]` — no response
   - `[REACT:emoji]` — react with an emoji instead of replying
   - `[IMAGE: prompt]` — generate and send a character image, or a subject-only image in full-access mode
   - `[IMAGE_SELF: prompt]` — generate the bot character in a scene in full-access mode
   - `[TTS]text[/TTS]` — send a voice note via the configured TTS provider
8. Background: memory evaluation extracts semantic facts, personality signals, and follow-up opportunities on the pinned `BACKGROUND_MODEL`; failed promotions are spooled and retried automatically

### Image Generation

The bot generates character images on a weekly schedule:

- One random day per week, at a random time between 8 AM and 11 PM (bot timezone)
- Pluggable provider: OpenAI (`IMAGE_PROVIDER=openai`), Gemini (`IMAGE_PROVIDER=gemini`), or fal.ai (`IMAGE_PROVIDER=fal`)
- Gemini uses `GEMINI_IMAGE_MODEL` (default `gemini-3-pro-image`) with a base character image (`memory/base.{png,jpg,jpeg}`)
- OpenAI uses `OPENAI_IMAGE_MODEL` (default `gpt-image-2`) independently of the chat model
- fal.ai defaults to Nano Banana Pro (`FAL_IMAGE_MODEL=nano-banana-pro`) and can be switched to GPT Image 2 with `FAL_IMAGE_MODEL=gpt-image-2`
- fal.ai sends `FAL_IMAGE_QUALITY=high` only when GPT Image 2 is selected; lower values can reduce latency and cost
- fal.ai uses the model's `/edit` endpoint when a base image exists (character images) and its base text-to-image endpoint for standalone generation (e.g., full-access mode illustrations)
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

Tests live in `tests/` and cover provider validation, prompt sections, response markers, handlers, memory, file-lock behavior, configuration parsing, and utility logic.

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

### Headless Profile and Rules

For VPS deployments where only the compiled executable is available, use JSON files under `memory/`:

- `memory/bot_profile.json` controls the bot's manual identity/personality: name, birth year, gender, language, and personality description.
- `memory/bot_rules.json` adds optional conversational rules: custom instructions, style rules, relationship rules, group rules, and new-person rules.

Create or inspect them with:

```bash
./mgsbot --init-profile
./mgsbot --show-profile
./mgsbot --init-rules
./mgsbot --show-rules
```

The rules file augments the prompt. It does not override code-level behavior such as access control, provider selection, marker parsing, memory limits, or security checks.

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

The bot's conversational language is configured during setup and stored in `memory/bot_config.json`, or manually in `memory/bot_profile.json` for headless deployments. The setup wizard and in-Telegram personality setup both support English and Spanish. The bot adapts to the user's language naturally.

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Bot framework:** [grammY](https://grammy.dev)
- **AI:** [OpenAI](https://platform.openai.com) (default chat `gpt-5.6-luna`) and/or [Google GenAI](https://ai.google.dev)
- **Language:** TypeScript (strict mode)
- **Linter/Formatter:** [Biome](https://biomejs.dev) — tabs, double quotes, auto-organized imports

## License

[MIT](LICENSE)
