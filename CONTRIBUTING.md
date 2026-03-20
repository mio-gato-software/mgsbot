# Contributing to andrordbot

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Install [Bun](https://bun.sh) v1.3+
2. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/eliaquinencarnacion/andrordbot.git
   cd andrordbot
   bun install
   ```

3. Copy `.env.sample` to `.env` and fill in at least the required variables (`BOT_TOKEN`, `GOOGLE_API_KEY`, `OWNER_USER_ID`)
4. Run `bun run dev` to start the bot in watch mode

## Code Style

This project uses [Biome](https://biomejs.dev) for linting and formatting:

- Tabs for indentation
- Double quotes
- Auto-organized imports

**Always run `bun run lint:fix` before committing.** This auto-fixes formatting and import order.

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run `bun run lint:fix`
4. Test your changes locally with a real Telegram bot
5. Open a pull request

## Pull Requests

- Keep PRs focused on a single change
- Describe what you changed and why
- If adding a new feature, update the README and `.env.sample` as needed

## Adding a Chat Provider

The provider system is pluggable. To add a new provider:

1. Create `src/providers/yourprovider.ts` implementing the `ChatProvider` interface from `src/providers/types.ts`
2. Add the provider to the `switch` statements in `src/providers/index.ts` (both `createChatProvider` and `switchChatProvider`)
3. Add the required env vars to `.env.sample`
4. Document it in the README configuration table

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Your environment (Bun version, OS, chat provider)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
