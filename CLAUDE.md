# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

andrordbot is a conversational Telegram bot built with **grammY** + **Google Gemini**, running on **Bun**. It features a 3-tier memory system (permanent, long-term, short-term), per-member fact storage, and responds naturally to text, voice notes, audio files, photos/images, and YouTube links. It can also generate images of its character and respond with TTS voice notes.

## Commands

```bash
bun install          # Install dependencies
bun run start        # Run the bot
bun run dev          # Run the bot in watch mode
```

TypeScript is executed directly by Bun (no emit).

## Lint & Format

```bash
bun run lint         # Check lint + format issues
bun run lint:fix     # Auto-fix lint + format issues
bun run format       # Format only
```

**Rule: Always run `bun run lint:fix` after making changes to ensure code passes all Biome checks.**

Biome config: tabs for indentation, double quotes, recommended lint rules, auto-organized imports.

## Architecture

```
index.ts                     ← Entry point: bot setup, handler registration, bot.start()
src/
  types.ts                   ← TypeScript interfaces for memory structures
  ai.ts                      ← GoogleGenAI instance, transcribeAudio(), describeImage(), analyzeYouTube(),
                               evaluateMemory(), textToSpeech(), generateImage()
  memory.ts                  ← Read/write for all memory tiers + text similarity/dedup utilities
  prompt.ts                  ← Prompt assembly: buildSystemPrompt(), buildMessages(), activity/time context
  handlers.ts                ← grammY handlers: voice, audio, photo, text (catch-all), YouTube detection,
                               /provider command, security middleware (ALLOWED_GROUP_ID + OWNER_USER_ID guard)
  weather.ts                 ← Gemini function-calling tool: get_current_weather (Open-Meteo API, Santo Domingo)
  providers/
    types.ts                 ← ChatProvider interface and ChatMessage type
    index.ts                 ← Provider factory: createChatProvider(), switchChatProvider(), getChatProviderInfo()
    gemini.ts                ← Gemini provider implementation (with weather function calling)
    openrouter.ts            ← OpenRouter provider implementation
    anthropic.ts             ← Anthropic API provider implementation
    azure.ts                 ← Azure OpenAI provider implementation
  brendy-appearance.ts       ← Locates base character image for image generation
  holidays.ts                ← Dominican Republic holidays (hardcoded for current year, needs annual update)
  daily-weather.ts           ← Fetches weather from Open-Meteo API, cached daily in memory/daily-weather.json
memory/
  permanent.md               ← Bot personality and rules, manually edited
  long-term.json             ← Shared global memory, auto-managed
  members.json               ← Per-member facts, auto-managed
  short-term/
    <chat_id>.json            ← One file per chat (group or DM)
  brendy-base.{png,jpg,jpeg} ← Reference image for character image generation
audios/                      ← Downloaded audio files and generated TTS
```

### Chat Provider System

`generateResponse()` delegates to a pluggable chat provider selected by `CHAT_PROVIDER` env var. The provider is a cached singleton implementing the `ChatProvider` interface. Available providers: `gemini` (default), `openrouter`, `anthropic`, `azure`, `alibaba`. The provider can be switched at runtime via the `/provider` Telegram command (DM only, owner only).

### Weather Function Calling

The Gemini provider registers a `get_current_weather` function tool. When the model decides weather info is relevant (user asks about weather, plans outdoor activities, etc.), it triggers a function call that fetches real-time data from the Open-Meteo API (Santo Domingo). The result is fed back to the model for a natural response. This is separate from `daily-weather.ts` which provides weather context for image generation prompts.

### Memory System

- **Permanent** (`memory/permanent.md`): Bot personality and rules, manually edited. Cached with 1-minute refresh.
- **Long-term** (`memory/long-term.json`): Global memories auto-extracted every 5 messages. Max 50 entries, pruned by composite score (importance × recency). Top 12 selected for prompts using relevance-weighted scoring (50% context relevance, 30% importance, 20% recency). Deduplication uses Jaccard similarity on key terms + bigrams (threshold 0.6).
- **Short-term** (`memory/short-term/<chat_id>.json`): Per-chat message history (last 30 messages) + rolling summary. When messages exceed 30, oldest 15 are summarized via AI. Inactive chats (>3 days) clear messages but keep summary.
- **Member facts** (`memory/members.json`): Per-person facts (job, hobbies, relationships, etc.) auto-extracted alongside long-term memories. Keys are canonicalized via alias map to prevent duplicates (e.g., "empleo"/"ocupacion"/"profesion" all map to "trabajo").

### Conversation Flow

1. Security middleware checks `ALLOWED_GROUP_ID` and `OWNER_USER_ID`
2. Load short-term memory for the chat
3. In groups: detect mention type (reply/tag/name/none) — only respond when mentioned
4. Assemble prompt: permanent.md + relevant long-term memories + member facts + previous summary + activity context + weather (for image gen)
5. Call chat provider, save exchange, reply (with Markdown, falling back to plain text)
6. Special response markers: `[SILENCE]` (no response), `[REACT:emoji]` (emoji reaction), `[IMAGE: prompt]` (generate character image), `[TTS]text[/TTS]` (voice reply via LemonFox)
7. Every 5 messages: background memory evaluation for long-term + member fact storage

### Image Generation

Once weekly (random day and time between 8am–11pm DR time), the bot includes an `[IMAGE: ...]` marker. The prompt is sent to `gemini-3-pro-image-preview` along with the base character image. The weekly schedule is tracked per-chat via `lastImageDate` (week start date), `imageTargetDate` (current week), and `imageTargetTime` (ISO timestamp of the chosen moment) in short-term memory.

## Environment

Requires a `.env` file (see `.env.sample`). Key variables:

- `BOT_TOKEN` (required): Telegram bot token
- `CHAT_PROVIDER`: `gemini` (default), `openrouter`, `anthropic`, `azure`, or `alibaba`
- `GOOGLE_API_KEY`: Required for Gemini provider and all media processing (transcription, image gen, etc.)
- `GEMINI_MODEL`: Gemini chat model (default: `gemini-3-flash-preview`)
- `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`: Required if using OpenRouter
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`: Required if using Anthropic
- `AZURE_API_KEY` / `AZURE_ENDPOINT` / `AZURE_MODEL`: Required if using Azure
- `DASHSCOPE_API_KEY` / `DASHSCOPE_MODEL`: Required if using Alibaba (DashScope)
- `ALLOWED_GROUP_ID` / `OWNER_USER_ID`: Access control
- `LEMON_FOX_API_KEY`: For TTS voice responses
- `SIMPLE_ASSISTANT_MODE`: Set `true` to disable personality, media processing, image gen, and memory
- `NODE_ENV`: Set `development` for verbose logging

## Tech Stack

- **Runtime:** Bun v1.3.8
- **Bot framework:** grammY (`grammy` ^1.39.3)
- **AI:** Google GenAI (`@google/genai` ^1) — Gemini 3 Flash Preview (chat), Gemini 3 Pro Image Preview (image gen)
- **Language:** TypeScript (strict mode, ESNext target, bundler module resolution)
- **Source code language:** English (variables, functions, comments, file names)
- **Linter/Formatter:** Biome (`@biomejs/biome` 2.3.14)
- **Bot conversational language:** Adapts to user (default Spanish, configured in `memory/permanent.md`)
