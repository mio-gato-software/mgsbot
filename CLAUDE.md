# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

andrordbot is a Telegram bot built with the **grammY** framework, running on **Bun**. It receives voice notes and audio files from Telegram users and saves them to the local `./audios/` directory.

## Commands

```bash
bun install          # Install dependencies
bun run index.ts     # Run the bot
```

No test runner, linter, or build step is configured. TypeScript is executed directly by Bun (no emit).

## Architecture

Single-file application (`index.ts`) with three grammY message handlers:

- `message:voice` — Downloads voice notes as `.ogg` files (`voice_{message_id}.ogg`)
- `message:audio` — Downloads audio files with extension derived from MIME type (`audio_{message_id}.{ext}`)
- `message` (catch-all) — Logs the message and replies with a greeting

Audio files are fetched from the Telegram Bot API via HTTP and written to `./audios/` using `Bun.write()`. The bot runs in long-polling mode via `bot.start()`.

## Environment

Requires a `.env` file with `BOT_TOKEN` (Telegram bot token). An `OPENAI_API_KEY` is also present in `.env` but currently unused in code.

## Tech Stack

- **Runtime:** Bun v1.3.8
- **Bot framework:** grammY (`grammy` ^1.39.3)
- **Language:** TypeScript (strict mode, ESNext target, bundler module resolution)
- **Code comments are in Spanish**
