# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

andrordbot is a conversational Telegram bot built with **grammY** + **Google Gemini**, running on **Bun**. It features a 3-tier memory system (permanent, long-term, short-term) and responds naturally to text, voice notes, and audio files.

## Commands

```bash
bun install          # Install dependencies
bun run index.ts     # Run the bot
```

TypeScript is executed directly by Bun (no emit).

## Lint & Format

```bash
bun run lint         # Check lint + format issues
bun run lint:fix     # Auto-fix lint + format issues
bun run format       # Format only
```

**Rule: Always run `bun run lint:fix` after making changes to ensure code passes all Biome checks.**

## Architecture

```
index.ts                     ← Entry point: bot setup, handler registration, bot.start()
src/
  types.ts                   ← TypeScript interfaces for memory structures
  ai.ts                      ← GoogleGenAI instance, generateResponse(), transcribeAudio(), evaluateMemory()
  memory.ts                  ← Read/write for all three memory tiers
  prompt.ts                  ← Prompt assembly: buildSystemPrompt(), buildContents()
  handlers.ts                ← grammY handlers: onVoice(), onAudio(), onMessage()
memory/
  permanent.md               ← Manual config by bot creator (personality, rules, response behavior)
  long-term.json             ← Shared global memory, auto-managed
  short-term/
    <chat_id>.json           ← One file per chat (group or DM)
audios/                      ← Downloaded audio files
```

### Memory System

- **Permanent** (`memory/permanent.md`): Bot personality and rules, manually edited. Cached with 1-minute refresh.
- **Long-term** (`memory/long-term.json`): Global memories auto-extracted every 5 messages. Max 50 entries, pruned by importance × recency. Top 15 included in prompts.
- **Short-term** (`memory/short-term/<chat_id>.json`): Per-chat message history (last 30 messages) + rolling summary. Inactive chats (>3 days) clear messages but keep summary.

### Conversation Flow

1. Load short-term memory for the chat
2. In groups: check if mentioned/replied to, otherwise model decides (can respond `[SILENCE]`)
3. Assemble prompt: permanent.md + relevant long-term memories + previous summary + message history
4. Call Gemini, save exchange, reply
5. Every 5 messages: background memory evaluation for long-term storage

## Environment

Requires a `.env` file with `BOT_TOKEN` (Telegram bot token) and `GOOGLE_GENAI_API_KEY` (Google GenAI API key).

## Tech Stack

- **Runtime:** Bun v1.3.8
- **Bot framework:** grammY (`grammy` ^1.39.3)
- **AI:** Google GenAI (`@google/genai` ^1) — Gemini 3 Flash Preview
- **Language:** TypeScript (strict mode, ESNext target, bundler module resolution)
- **Source code language:** English (variables, functions, comments, file names)
- **Bot conversational language:** Adapts to user (default Spanish, configured in `memory/permanent.md`)
