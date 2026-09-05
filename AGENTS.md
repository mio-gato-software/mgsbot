# Repository Agent Guide

This file provides guidance to AI coding agents working with this repository.

**Pending work:** [TODO.md](./TODO.md) tracks known pending tasks with their context and prerequisites. Check it before starting maintenance work; when you finish an item, delete it; when you discover follow-up work you aren't doing now, add it there.

## Project Overview

MGS Bot is a conversational Telegram bot built with **grammY** + pluggable AI providers (**OpenAI** or **Google Gemini**), running on **Bun**. It features a multi-tier memory system (semantic facts, episodes, sensory buffer, relationships, monthly chapters), vector embeddings for semantic search, an emergent personality system, proactive follow-ups and check-ins, and responds naturally to text, `.txt` attachments, voice notes, audio files, photos/images, PDFs, and YouTube links. It can also generate images of its character and respond with TTS voice notes. OpenAI alone (`OPENAI_API_KEY`, default chat model `gpt-5.6-luna`) covers most functionality; Gemini remains optional.

## Commands

```bash
bun install          # Install dependencies
bun run start        # Run the bot
bun run dev          # Run the bot in watch mode
bun test             # Run the test suite (tests/)
bun run typecheck    # TypeScript type check (tsc --noEmit)
bun run build        # Compile to a single executable (./mgsbot)
bun run build:linux  # Cross-compile for Linux x64
```

Headless profile/rules management (no chat setup needed):

```bash
bun run profile:init   # Write memory/bot_profile.json template
bun run profile:show   # Show current profile status
bun run profile:sync   # Apply bot_profile.json to bot config
bun run rules:init     # Write memory/bot_rules.json template
bun run rules:show     # Show current rules status
bun run promote:stats  # Promotion bar calibration + extraction-quality report
```

Releases: `bun run release:patch|minor|major` bumps the version, tags, and pushes (CI builds the binaries).

TypeScript is executed directly by Bun (no emit) — which means type errors do NOT fail at runtime. CI runs `bun run typecheck`; run it locally before committing.

## Lint & Format

```bash
bun run lint         # Check lint + format issues
bun run lint:fix     # Auto-fix lint + format issues
bun run format       # Format only
```

**Rule: Always run `bun run lint:fix` and `bun run typecheck` after making changes.**

Biome uses its defaults (tabs for indentation, double quotes, recommended lint rules, auto-organized imports). `biome.json` only enables git-ignore integration (`vcs.useIgnoreFile`) so runtime data folders (`memory/`, `audios/`, `logs/`) are skipped — don't delete it, or lint will scan runtime JSON.

## Architecture

```
index.ts                     ← Entry point: env loading, CLI flags (--setup, --init-profile, --init-rules, ...),
                               handler registration, periodic jobs (follow-ups/check-ins), graceful shutdown
src/
  types.ts                   ← TypeScript interfaces for all memory/data structures (incl. TRAIT_NAMES)
  handlers.ts                ← grammY handlers: voice, audio, photo, text (catch-all), YouTube detection,
                               group routing (mention/continuation/spontaneous), security middleware
                               (ALLOWED_GROUP_ID + OWNER_USER_ID guard)
  group-state.ts             ← In-memory group rate limits: spontaneous-reply cooldowns, continuation windows
  conversation.ts            ← Main turn pipeline (named options and injectable generation/retrieval/delivery): sensory append, memory retrieval, prompt assembly,
                               provider call, response send, episode promotion, background evaluation
  response-plan.ts           ← Pure marker parsing into a structured delivery plan
  background-tasks.ts        ← Recurring jobs, overlap protection, and shutdown draining
  runtime-paths.ts           ← MEMORY_DIR resolution; tests override it with a disposable root
  response-processor.ts      ← Validated response delivery and marker handling ([SILENCE], [REACT], [IMAGE], [TTS], [QUOTE_REPLY]),
                               image/TTS sending, Markdown fallback
  media-handlers.ts          ← Telegram media download and preprocessing (voice, audio, photo, PDF, `.txt`)
  commands.ts                ← Telegram commands: /provider, /allowphotorequest, /help, /on, /off, /optimize
  provider-options.ts        ← Provider metadata, env validation, /provider runtime status formatting
  embeddings.ts              ← Embedding generation (Gemini or OpenAI) with disk-persisted LRU cache
  personality.ts             ← Emergent personality: 8 fixed traits with momentum, growth events, prompt tiers
  identities.ts              ← User identity tracking: canonical names, aliases, name change handling
  check-ins.ts               ← Proactive check-in messages: cadence-driven weekly scheduling, strategy rotation
  follow-ups.ts              ← Proactive follow-up detection, scheduling, and delivery (timezone-aware)
  image-scheduler.ts         ← Weekly character image schedule (week start, random target date/time)
  config.ts                  ← Bot configuration state (bot_config.json, bot_profile.json, legacy permanent.md migration)
  setup.ts                   ← Interactive in-chat personality setup conversation
  wizard.ts                  ← Browser-based .env setup wizard (--setup flag / missing credentials)
  bot-state.ts               ← Runtime on/off state (/on, /off) and sleep-hour check
  bot-rules.ts               ← Optional headless behavior/style rules (memory/bot_rules.json)
  appearance.ts              ← Locates base character image for image generation
  janitor.ts                 ← Daily semantic-memory janitor: reviews same-subject fact clusters via
                               the background model, soft-retires contradictions/duplicates
  holidays.ts                ← Holiday calendar (hardcoded per year, needs annual update)
  daily-weather.ts           ← Fetches weather from Open-Meteo API, cached daily in memory/daily-weather.json
  chat-logger.ts             ← Daily conversation log to text files (logs/ folder), toggled via ENABLE_CHAT_LOG
  bot-time.ts                ← Centralized timezone utilities via dayjs (BOT_TIMEZONE env var, default: America/Santo_Domingo)
  chat-actions.ts            ← Sustained Telegram chat-action indicators: refresh loop (actions expire ~5s),
                               per-modality switching (typing/upload_photo/record_voice), proactive typing pulse
  utils.ts                   ← atomicWriteFile(), withRetry(), env file parsing, misc helpers
  ai/
    core.ts                  ← generateResponse() + background work (Gemini or OpenAI)
    platform.ts              ← AI_PLATFORM + independent support-axis model/provider resolution
    classifiers.ts           ← Lightweight LLM classifiers (routing decisions)
    evaluation.ts            ← Background memory evaluation: semantic facts, personality signals, follow-ups
    vision.ts                ← Image description, YouTube analysis
    documents.ts             ← PDF analysis via Gemini or OpenAI
  prompt/
    pipeline.ts              ← Section pipeline: ordered, mode-aware prompt assembly
    assemble.ts              ← buildSystemPrompt() entry point
    context.ts               ← PromptContext construction from memory/state
    retrieval.ts             ← Shared context retrieval for conversation and proactive messages
    history.ts               ← buildMessages(): sensory buffer → ChatMessage[] with time-gap markers
    modes.ts                 ← SIMPLE_ASSISTANT_MODE / full-access mode checks
    types.ts                 ← Prompt section interfaces
    sections/                ← One file per prompt section: header, identity, personality, memory,
                               activity, mention, image, voice, rules
  memory/
    promotion.ts             ← Durable promotion worker: prepared checkpoints and idempotent effects
    storage.ts               ← Validated JSON reads/writes; corruption and future schemas fail closed
    schemas.ts               ← Runtime schemas for persisted memory
    index.ts                 ← Re-exports + store initialization
    sensory.ts               ← Per-chat recent messages buffer (max 10, FIFO, boundary-aware overflow promotion)
    promotion-spool.ts       ← Per-chat journal of unpromoted message chunks (sensory overflow +
                               inactivity-wipe remainders), retried at startup/hourly
    promotion-policy.ts      ← Promotion importance bars (env-tunable) + meetsPromotionBar() gate
    promotion-metrics.ts     ← Per-decision telemetry (memory/metrics/): what each bar dropped and
                               how the background model is extracting (see promote:stats)
    episodes.ts              ← Per-chat episode summaries with embeddings (max 20)
    semantic.ts              ← Global semantic facts: dedup, confidence decay, permanent facts
    relationships.ts         ← Per-chat relationship memory (summary, tone, dynamics, open threads)
    chapters.ts              ← Per-chat monthly narrative chapters built from episodes
    queries.ts               ← normalizeName(), computeTextScore(), query embeddings
    locks.ts                 ← withChatLock(): per-chat async serialization
  providers/
    types.ts                 ← ChatProvider interface and ChatMessage type
    index.ts                 ← Provider factory: createChatProvider(), switchChatProvider(), getChatProviderInfo()
    openai-compatible.ts     ← Base class for OpenAI-wire-format providers: fetch, retry, errors, token logging
    gemini.ts                ← Gemini provider implementation (with weather function calling)
    openrouter.ts            ← OpenRouter provider (extends openai-compatible)
    azure.ts                 ← Azure OpenAI provider (extends openai-compatible)
    alibaba.ts               ← Alibaba DashScope provider (extends openai-compatible)
    fireworks.ts             ← Fireworks AI provider (extends openai-compatible, adds vision)
    anthropic.ts             ← Anthropic API provider implementation
    openai.ts                ← OpenAI provider implementation (OpenAI SDK, Responses API)
    deepseek.ts              ← DeepSeek provider implementation (OpenAI SDK)
    fal.ts                   ← fal.ai provider implementation
  stt/                       ← Speech-to-text providers: gemini, openai, fal, lemonfox (+ index factory)
  image/                     ← Image generation providers: gemini, openai, fal (+ index factory)
  tts/                       ← Text-to-speech providers: cartesia, elevenlabs, inworld, lemonfox, openai, fal (+ index factory)
scripts/                     ← One-off maintenance utilities: migrate-memory, reembed-memory, merge-person-facts
tests/                       ← bun test suite (config, handlers, locks, memory, prompt, provider-options,
                               response-markers, sensory, utils)
memory/                      ← Runtime data (gitignored)
  bot_config.json            ← Bot setup state (name, birthYear, gender, personality, isConfigured)
  bot_profile.json           ← Optional manual profile (headless alternative to chat setup)
  bot_rules.json             ← Optional manual behavior/style rules
  permanent.md               ← Legacy personality file (migration source only)
  semantic.json              ← Global semantic facts with embeddings, categories, confidence decay
  identities.json            ← User ID → canonical name + alias tracking
  personality.json           ← Evolving personality traits and growth events
  follow-ups.json            ← Pending/sent proactive follow-ups
  check-ins.json             ← Proactive check-in weekly slots and state per DM chat
  embedding-cache.json       ← LRU cache of vector embeddings (max 5000, SHA256-keyed)
  embedding-config.json      ← Last embedding provider/model/dim used; startup re-embeds if this changes
  daily-weather.json         ← Cached daily weather data
  episodes/<chat_id>.json    ← Per-chat episode summaries with embeddings (max 20)
  sensory/<chat_id>.json     ← Per-chat recent messages (max 10) + image scheduling
  promotion-spool/<chat_id>.json ← Per-chat unpromoted chunks awaiting promotion retry
  metrics/promotion-YYYY-MM.jsonl ← Promotion decisions: bar outcomes + extraction quality
  relationships/<chat_id>.json ← Per-chat relationship memory
  chapters/<chat_id>.json    ← Per-chat monthly chapters
  base.{png,jpg,jpeg}        ← Optional reference image for character image generation
audios/                      ← Downloaded audio files and generated TTS
logs/
  <YYYY-MM-DD>.txt           ← Daily conversation logs (gitignored)
```

### Chat Provider System

`generateResponse()` delegates to a pluggable chat provider selected by `CHAT_PROVIDER` env var. The provider is a cached singleton implementing the `ChatProvider` interface. Available chat providers: `gemini` (default), `openrouter`, `anthropic`, `azure`, `alibaba`, `fireworks`, `openai`, `deepseek`, and `fal`. The provider can be switched at runtime via the `/provider` Telegram command (DM only, owner only).

There are four independent provider axes:

| Axis | Env var | Controls | Default / fallback |
| --- | --- | --- | --- |
| Chat | `CHAT_PROVIDER` | Main conversation replies and `/provider` runtime switching | `gemini` if Google is set, else `openai` |
| Speech-to-text | `STT_PROVIDER` | Voice/audio transcription | platform key -> `fal` -> `lemonfox` |
| Text-to-speech | `TTS_PROVIDER` | `[TTS]...[/TTS]` and random voice replies | `elevenlabs` -> `inworld` -> `lemonfox` -> `openai`; Cartesia and fal only when explicit |
| Images | `IMAGE_PROVIDER` + model env | Character image generation/editing | `openai` or `gemini` from `AI_PLATFORM`; fal defaults to `nano-banana-pro` |

`/provider` only changes the chat axis. It does not change transcription, voice replies, image generation, embeddings, YouTube analysis, or fallback image analysis. Background memory work is pinned to `BACKGROUND_MODEL` on `BACKGROUND_PROVIDER` (defaults to `AI_PLATFORM`) so the chat model choice doesn't multiply background costs.

### Memory System

The memory system uses multiple tiers with vector embeddings for semantic search (`src/memory/`):

- **Semantic Store** (`memory/semantic.json`): Global knowledge base of `SemanticFact` objects with 768-dim embeddings. Categories: "person", "group", "rule", "event". Facts have `importance`, `confidence` (decays 0.02/day, min 0.1), and `subject`. Deduplication via cosine similarity at 0.85 threshold. Facts injected into a prompt are reinforced (small confidence bump, throttled to once/hour per fact via `lastRecalledAt`), so often-recalled facts fade more slowly — but retrieval is usefulness, not evidence: the bump is capped by `reinforcementCeiling()` (0.75, eroding 0.01/day as `lastConfirmed` ages) and never touches the decay clock, so a fact the bot only ever quotes back to itself still decays out. Only genuine reconfirmation through extraction (the dedup merge path) moves `lastConfirmed` and lifts a fact above the ceiling. Facts can be marked `permanent: true` for immutable biographical data (birthplace, family, marriage) — these never decay and are always included in prompts (max 25). A daily janitor (`src/janitor.ts`, disable with `ENABLE_MEMORY_JANITOR=false`) reviews subjects with ≥6 active facts via the background model and soft-retires contradicted/duplicate facts (`supersededBy` + `validUntil`, never hard deletion).
- **Episodes** (`memory/episodes/<chat_id>.json`): Per-chat summarized conversations (max 20). Each episode has `summary`, `participants`, `timestamp`, `importance`, and an `embedding` for similarity search. Top 3 most relevant episodes selected for prompts.
- **Sensory Buffer** (`memory/sensory/<chat_id>.json`): Per-chat recent messages (max 10, FIFO). Tracks `lastActivity`, `messageCountSincePromotion`. On overflow, the oldest 3–7 messages (split at the largest ≥30-min time gap, default 5) are promoted to an episode via AI summarization. Inactive chats (>3 days) spool remaining messages for promotion, then clear the buffer. Passively witnessed group messages (bot not addressed) are promoted only at a higher importance bar (default ≥3, `PASSIVE_PROMOTION_MIN_IMPORTANCE`). Bars live in `src/memory/promotion-policy.ts`; every decision is recorded by `src/memory/promotion-metrics.ts` so `bun run promote:stats` can replay the gate at each candidate bar instead of guessing (it also lists the chunks the current bar dropped).
- **Promotion Spool** (`memory/promotion-spool/<chat_id>.json`): Durable journal of sensory overflow and inactivity-wipe remainders, with checkpoints for partial promotion recovery. Retried on the next promotion for that chat, at startup, and hourly; after 10 failed attempts a chunk is retained with `failed: true` and an owner alert, for operator recovery.
- **Relationships** (`memory/relationships/<chat_id>.json`): Per-chat relationship memory — an evolving summary of the relationship dynamic (tone, notable dynamics, open threads, interaction count).
- **Chapters** (`memory/chapters/<chat_id>.json`): Per-chat monthly narrative chapters built from episodes (id `chapter_<chatId>_<YYYY-MM>`, title, compact summary, importance 1–5).

The bot's own identity/personality prompt comes from `bot_config.json` (chat setup) or `bot_profile.json` (headless manual profile) — `memory/permanent.md` is legacy and only used as a one-time migration source.

Per-chat writes are serialized with `withChatLock()` (`src/memory/locks.ts`); state files are saved via `atomicWriteFile()` to avoid corruption on crash.

**Storage maintenance:** `MEMORY_DIR` defaults to `./memory`; `bun test` forces a disposable root through `tests/preload.ts`. Loaders validate legacy and v1 data and preserve damaged files by refusing writes. Backups are staged, hashed, verified, then published; startup awaits a verified daily snapshot before migrations. Daily confidence decay is checked hourly during continuous uptime. See `docs/maintenance.md` for recovery.

**Embeddings** (`src/embeddings.ts`): Uses `EMBEDDING_PROVIDER` (`gemini-embedding-2` or `text-embedding-3-small`, both default 768-d). Disk-persisted LRU cache (max 5000 entries) at `memory/embedding-cache.json`, persisted every 60 seconds by the application lifecycle; importing the module starts no timer. Cache keys include model+dim so switching providers does not mix vectors. Startup compares `memory/embedding-config.json` to the current provider/model/dim and rewrites stale fact/episode vectors (`src/memory/reembed.ts`; disable with `AUTO_REEMBED=false`). Used for semantic fact dedup, episode relevance ranking, and memory retrieval.

**Identities** (`src/identities.ts`): Maps Telegram user IDs to canonical names with alias tracking. Handles name changes by adding old names as aliases. Prefix matching (e.g., "Eliaquín" matches "Eliaquín Encarnación"). Used to link facts across name variations.

### Personality System

The bot develops emergent personality traits that evolve over conversations (`src/personality.ts`):

- **Traits**: A fixed set of 8 traits (`TRAIT_NAMES` in `src/types.ts`): warmth, humor, patience, curiosity, assertiveness, energy, vulnerability, playfulness. Each has `value` (0.0–1.0), `momentum`, and `lastReinforced` timestamp.
- **Updates**: Background evaluation emits per-trait deltas; momentum smooths changes (`momentum = momentum * 0.7 + delta`) and values are clamped to [0, 1].
- **Growth events**: Records what caused trait changes (max 10 recent events kept).
- **Prompt rendering**: Each trait maps to a tier (low ≤ 0.33, mid, high ≥ 0.67) that selects the phrasing injected into the system prompt.
- Stored in `memory/personality.json` (legacy free-form trait files are migrated to the fixed set on load).

### Follow-Up System

Proactive follow-up feature (`src/follow-ups.ts`), enabled via `ENABLE_FOLLOW_UPS=true`:

- Detects planned events/activities from conversations and schedules follow-up questions.
- DR timezone-aware scheduling (8am–9:30pm reasonable hours).
- Rate limited: max 2 sends/day, 2-hour cooldown between sends (based on recorded `sentAt`).
- Expiration after 3 days. Cancelled if user already mentioned the topic.
- Topic dedup: a newly detected event similar to any follow-up tracked in the last 14 days (any status) is skipped, so the same topic can't resurface week after week.
- Won't interrupt active conversations (15-min cooldown).
- Stored in `memory/follow-ups.json` (gitignored).

### Check-In System

Proactive check-in feature (`src/check-ins.ts`), enabled via `ENABLE_CHECK_INS=true`:

- Cadence-driven (not event-driven like follow-ups): bot reaches out ~2 times/week to chat like a real friend.
- Weekly slot scheduling: at the start of each Monday-based week, generates N random time slots with minimum 2-day gap.
- Time slots weighted toward morning (10-12) and evening (17-20) windows, clamped to 8am–9:30pm.
- If bot starts mid-week, only schedules slots for remaining days.
- Check-in strategies rotate to avoid repetition: `random_thought`, `memory_callback`, `sharing_moment`, `reaction`, `weather_vibe`, `curiosity`.
- Full context generation: loads sensory buffer, relevant episodes, semantic facts, and builds system prompt for natural messages.
- Topic freshness: the last 5 proactive messages plus recent follow-up events are injected into the prompt as topics NOT to bring up again.
- Silence-aware backoff: tracks consecutive proactive sends with no user reply (`unansweredStreak`). After 1 unanswered send, `memory_callback` is excluded and the prompt instructs a fresh, no-pressure, self-contained message (never mention the silence); after 2+, cadence drops to at most one check-in per week until the user writes again.
- Guards: won't send if bot is off/sleeping, active conversation in last 15 min (postpones by 1 hour), or follow-up was sent today.
- Only targets DM chats (chatId == OWNER_USER_ID).
- Configurable frequency via `CHECK_INS_PER_WEEK` env var (default: 2).
- Stored in `memory/check-ins.json` (gitignored).

### Bot Setup System

Three setup paths:

- **Env wizard** (`src/wizard.ts`): browser-based form for `.env` credentials. Runs on `--setup` or when `BOT_TOKEN` or both AI keys are missing. Writes `.env` atomically, preserving unmanaged keys.
- **In-chat setup** (`src/setup.ts` + `src/config.ts`): first-run conversation asks for bot name, birth year, gender, personality description. Saves to `memory/bot_config.json`. Bot won't respond normally until setup completes.
- **Headless profile/rules** (`src/config.ts` + `src/bot-rules.ts`): `profile:init`/`profile:sync` manage `memory/bot_profile.json` (overrides chat setup); `rules:init` manages `memory/bot_rules.json` for behavior/style rules.
- Migration: if legacy `memory/permanent.md` exists but config doesn't, it is auto-migrated into `bot_config.json`.

### Conversation Flow

1. Security middleware checks `ALLOWED_GROUP_ID` and `OWNER_USER_ID`
2. If not configured, enter interactive setup flow
3. Load sensory buffer for the chat; register/update user identity
4. In groups: detect mention type (reply/tag/name/none). Text generally responds when directly addressed, but the group router may allow natural continuations/spontaneous replies.
5. Assemble prompt via the section pipeline (`src/prompt/`): bot identity/personality + relevant semantic facts + relevant episodes + relationship memory + sensory messages + activity/time context
6. Call chat provider, save exchange, reply (with Markdown, falling back to plain text)
7. Special response markers: `[SILENCE]` (no response), `[REACT:emoji]` (emoji reaction), `[IMAGE: prompt]` (generate character image), `[TTS]text[/TTS]` (voice reply via TTS provider)
8. Voice messages in DMs or direct group mentions are transcribed and processed normally. Passive group voice notes are transcribed only when `ENABLE_GROUP_VOICE_CONTEXT` is not `false` and duration is within `GROUP_PASSIVE_VOICE_MAX_SECONDS`; transcripts stored in sensory memory are capped by `GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS`. The bot only routes passive group voice for a response when the transcript addresses the bot by name or continues an open bot conversation.
9. When receiving a voice message, the bot may respond with a voice note via `[TTS]` behavior and voice prompt guidance; it is not required to respond with voice every time.
10. Periodically: background memory evaluation (semantic facts + personality signals + follow-up detection)

### Image Generation

Once weekly (random day and time between 8am–11pm DR time), the bot includes an `[IMAGE: ...]` marker. The prompt is sent to the configured image provider (`GEMINI_IMAGE_MODEL`, `OPENAI_IMAGE_MODEL`, or fal) along with the base character image. Weekly schedule tracked per-chat via `lastImageDate`, `imageTargetDate`, and `imageTargetTime` in sensory buffer. Photo requests gated by `allowPhotoRequest` flag (toggled via `/allowphotorequest` command).

### Sleep Schedule

Bot sleeps 11:30 PM – 6:00 AM DR time by default. Controlled by `ENABLE_SLEEP_SCHEDULE` (default: `true`).

## Environment

Requires a `.env` file (see `.env.sample`). Key variables:

- `BOT_TOKEN` (required): Telegram bot token
- `CHAT_PROVIDER`: `gemini` or `openai` by available key, plus `openrouter`, `anthropic`, `azure`, `alibaba`, `fireworks`, `deepseek`, or `fal`
- `AI_PLATFORM`: Default for chat + support axes (`gemini` or `openai`). Auto-selects `openai` when only `OPENAI_API_KEY` is set.
- `OPENAI_API_KEY`: Enough on its own for most features. Default chat model is `gpt-5.6-luna`.
- `GOOGLE_API_KEY`: Optional if OpenAI is set. Still required for Gemini chat/support and YouTube analysis.
- `GEMINI_MODEL`: Gemini chat model (default: `gemini-3.6-flash`)
- `BACKGROUND_MODEL`: Pinned model for background memory work — fact extraction, narrative updates, janitor (defaults to `gpt-5.6-luna` or `gemini-3.6-flash` from `BACKGROUND_PROVIDER`)
- `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`: Required if using OpenRouter (default model: `anthropic/claude-3.5-sonnet`)
- `OPENROUTER_HTTP_REFERER` / `OPENROUTER_TITLE`: Optional attribution headers for OpenRouter requests
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`: Required if using Anthropic (default model: `claude-sonnet-4-5-20250929`)
- `AZURE_API_KEY` / `AZURE_ENDPOINT` / `AZURE_MODEL`: Required if using Azure (default model: `Kimi-K2.5`)
- `DASHSCOPE_API_KEY` / `DASHSCOPE_MODEL`: Required if using Alibaba (default model: `qwen3.5-plus`)
- `FIREWORKS_API_KEY` / `FIREWORKS_MODEL`: Required if using Fireworks (default model: `accounts/fireworks/models/glm-5`)
- `OPENAI_MODEL`: OpenAI chat model (default: `gpt-5.6-luna`)
- `OPENAI_IMAGE_MODEL` / `GEMINI_IMAGE_MODEL`: Independent image-generation models
- `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`: Required if using DeepSeek (default model: `deepseek-v4-pro`)
- `FAL_API_KEY` / `FAL_MODEL`: Required if using fal.ai chat (default model: `google/gemini-2.5-pro`)
- `ALLOWED_GROUP_ID` / `OWNER_USER_ID`: Access control
- `LEMON_FOX_API_KEY`: For TTS voice responses (if `TTS_PROVIDER=lemonfox`) and audio transcription (STT)
- `CARTESIA_API_KEY` / `CARTESIA_VOICE_ID`: Required for Cartesia TTS; `CARTESIA_MODEL` defaults to `sonic-3.6` and `CARTESIA_LANGUAGE` is optional
- `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`: For ElevenLabs TTS voice responses (default voice ID if not set)
- `INWORLD_API_KEY` / `INWORLD_VOICE_ID`: For Inworld TTS voice responses
- `TTS_PROVIDER`: `cartesia`, `elevenlabs`, `inworld`, `lemonfox`, `openai`, or `fal`. When unset, auto-detects in order: elevenlabs -> inworld -> lemonfox -> openai; Cartesia and fal require explicit selection
- `STT_PROVIDER`: `gemini`, `openai`, `fal`, or `lemonfox`. When unset, prefers the AI platform key, then fal, then lemonfox
- `ENABLE_GROUP_VOICE_CONTEXT`: Set `false` to stop transcribing passive group voice notes; direct voice replies/mentions still transcribe
- `GROUP_PASSIVE_VOICE_MAX_SECONDS`: Maximum duration for passive group voice-note transcription (default: `120`)
- `GROUP_PASSIVE_VOICE_TRANSCRIPT_MAX_CHARS`: Maximum transcript characters stored for passive group voice context (default: `1200`)
- `IMAGE_PROVIDER`: `gemini`, `openai`, or `fal` (defaults from `AI_PLATFORM`)
- `FAL_IMAGE_MODEL`: fal.ai image model, `nano-banana-pro` (default) or `gpt-image-2`
- `FAL_IMAGE_QUALITY`: fal.ai GPT Image 2 quality, `low`, `medium`, or `high` (default)
- `FAL_IMAGE_TIMEOUT_MS`: fal.ai generation timeout in milliseconds (default: `300000`)
- `SIMPLE_ASSISTANT_MODE`: Set `true` to disable personality, media processing, image gen, and memory
- `ENABLE_FOLLOW_UPS`: Set `true` to enable proactive follow-ups in DMs
- `ENABLE_CHECK_INS`: Set `true` to enable proactive check-in messages in DMs (~2/week)
- `CHECK_INS_PER_WEEK`: Number of check-in messages per week (default: `2`)
- `ENABLE_CHAT_LOG`: Set `true` to enable daily conversation logging to `logs/` folder
- `ENABLE_SLEEP_SCHEDULE`: Set `false` to disable sleep schedule (default: `true`)
- `PROMOTION_MIN_IMPORTANCE` / `PASSIVE_PROMOTION_MIN_IMPORTANCE`: Promotion importance bars (default 2 / 3). Calibrate with `bun run promote:stats`
- `PROMOTION_METRICS` / `PROMOTION_METRICS_RETENTION_MONTHS`: Promotion decision telemetry (default on, 6 months)
- `ENABLE_MEMORY_JANITOR`: Set `false` to disable the daily semantic-memory janitor (default: `true`)
- `BOT_TIMEZONE`: IANA timezone for the bot (default: `America/Santo_Domingo`). Affects sleep schedule, time awareness, follow-ups, and weather.
- `SHOW_TRANSCRIPTION`: Set `true` to echo voice/audio transcriptions back as a `📝` reply (debug aid)
- `NODE_ENV`: Set `development` for verbose logging

## Tech Stack

- **Runtime:** Bun v1.4.1 (pinned in CI)
- **Bot framework:** grammY (`grammy` ^1.46.0)
- **AI:** OpenAI (`openai` ^7.10.0, default chat `gpt-5.6-luna`) and/or Google GenAI (`@google/genai` 2.21.0)
- **Language:** TypeScript (strict mode incl. `noUncheckedIndexedAccess`, ESNext target, bundler module resolution; checked via `bun run typecheck`)
- **Source code language:** English (variables, functions, comments, file names)
- **Linter/Formatter:** Biome (`@biomejs/biome` 2.5.12, config in `biome.json`)
- **Tests:** `bun test` (tests/ folder)
- **CI:** GitHub Actions (`ci.yml`: lint + typecheck + test on every push/PR; `release.yml`: cross-platform binaries on `v*` tags)
- **Bot conversational language:** Adapts to user (default Spanish, configured during setup)
