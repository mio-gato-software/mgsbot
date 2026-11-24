# MGS Bot

<p align="center">
  <img src="assets/bot-avatar.png" alt="MGS Bot" width="220" />
</p>

MGS Bot is a self-hosted Telegram bot for your DMs and, optionally, one group. It remembers details across conversations, works with voice notes, photos and documents, and can send reminders and scheduled research reports.

## Quick start

You'll need a Telegram bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram user ID, and an OpenAI or Google AI API key.

1. Get the source and create a local configuration file.

   ```sh
   git clone https://github.com/mio-gato-software/mgsbot.git
   cd mgsbot
   cp .env.sample .env
   ```

2. In `.env`, fill in `BOT_TOKEN`, `OWNER_USER_ID`, and either `OPENAI_API_KEY` or `GOOGLE_API_KEY`. For reminders at your local time, set `BOT_TIMEZONE` to your IANA timezone, such as `Europe/Madrid`. Leave `ALLOWED_GROUP_ID` blank for DM-only use.

3. Install dependencies and start the bot with **Bun 1.4.2**.

   ```sh
   bun install --frozen-lockfile
   bun run start
   ```

4. Open the bot in Telegram and send it a message from the owner account. The first conversation sets up its name and personality. After setup, send `/help` to see the commands.

**Other ways to run it.** With the same `.env`, Docker users can run `docker compose up -d --build` in the cloned repository. Standalone binaries for Linux x64, macOS ARM64 and Windows x64 can run directly from the directory containing `.env`. [Download a release](https://github.com/mio-gato-software/mgsbot/releases) · [Deployment and upgrades](docs/deployment.md)

## Try it in Telegram

| Send this | What happens |
| --- | --- |
| A PDF with “Summarize the main points” | The bot reads the document and summarizes it in the chat. |
| “Remind me tomorrow at 9 am to return the library books.” | The bot saves a one-time reminder and sends it in the same chat. |
| “Every Friday at 8 am, send me the weekend forecast for Madrid.” | The bot looks up the forecast at delivery time. Recurring tasks run for up to one calendar month and can be renewed in chat. |
| A public article link with “What does the author argue?” | The bot reads the linked page. Add `BRAVE_API_KEY` if you also want it to search for sources. |

Weather uses Open-Meteo and needs no extra key. YouTube analysis requires `GOOGLE_API_KEY`. Set `ENABLE_FOLLOW_UPS=true` or `ENABLE_CHECK_INS=true` to let the bot start conversations in your DMs. With Brave search and an allowed group, it can also post a weekly news item. [Configuration options](.env.sample) · [Agenda and research](docs/agenda-and-preferences.md) · [Weather](docs/weather.md)

## Profile, rules, and character image

To set up the persona before the first chat, run `bun run profile:init` and edit `memory/bot_profile.json`. For custom conversation rules, run `bun run rules:init` and edit `memory/bot_rules.json`. To give generated character photos a consistent appearance, place a reference image at `memory/base.png`, `memory/base.jpg`, or `memory/base.jpeg`.

Ask the character about a favorite film, a team it supports, or a belief. It can choose a lasting answer and carry that preference across DMs and the group. A later conversation can change its mind if it finds the reason persuasive. [How personality adapts](docs/adaptive-personality.md)

## Operating the bot

- **Telegram controls.** In the owner's DM, use `/off` and `/on` to pause and resume replies. Use `/provider` to inspect the current configuration, or `/provider <name> [model]` to switch the chat provider until restart.
- **Persistent data.** Back up `memory/` and keep it across upgrades. It holds conversation memory, profiles, character preferences and scheduled tasks. Run one bot process per store. Docker mounts `memory/`, `audios/` and `logs/` from the host. [Backups and recovery](docs/maintenance.md)
- **Development.** Use `bun run dev` for watch mode. Check changes with `bun run lint`, `bun run typecheck` and `bun test --coverage`. [Architecture and repository guide](AGENTS.md)

Forks are welcome. This project is closed to contributions. [MIT license](LICENSE)
