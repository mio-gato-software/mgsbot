# Brendy deployment on cachyos

Verified on 2026-10-22. SSH alias: `cachyos`; application directory: `/home/eliaquin/brendy`; user systemd unit: `brendy.service`. Its working directory and executable are in that directory; its environment file is `.env`. The remote user's login shell is fish, so use `ssh cachyos 'sh -s'` for POSIX deployment scripts.

Brendy uses `memory/bot_profile.json` and `memory/bot_rules.json`. Absence of `bot_config.json` is normal for this headless profile. Never initialize a replacement profile or memory directory during an upgrade. Other bots (`gatobot`, `hellybot`, `pelusabot`) are independent services and must remain untouched.

## Upgrade procedure

1. Merge the intended source and run lint, typecheck and the full test suite. Build the Linux executable and record the exact source commit and binary SHA-256.
2. Copy the executable to a staging filename inside Brendy's directory. Verify its hash and run `--help`, which exits without starting polling. There is no `--version` flag: an unknown flag can start the application.
3. Stop only `brendy.service`. Confirm its main PID is zero. With restrictive permissions, back up the existing executable, service definition, `.env`, the entire `memory` directory and the updater. Compare the archived state against the stopped files and save checksums before proceeding.
4. Atomically rename the staged executable to `mgsbot`, preserving executable permissions, and start the service. On startup failure, restore the old executable and restart. Do not automatically restore an old memory snapshot over newer conversations.
5. Check stable service PID, restart count, the running `/proc/<PID>/exe` hash, startup logs and successful Telegram polling. Compare configuration and memory against the snapshot; normal startup confidence decay may change `semantic.json`, but fact IDs/content must remain intact. Confirm other bots retain their original PIDs.

The shared `/tmp/mgsbot-heartbeat` is currently insufficient as an independent health signal when several bots run on the host; see the related TODO. Do not start a second polling process to test the same Telegram token.

## Agenda deployment record

- Source merge: `145297bffeb0a8fe4e8f4ee314f7d06823f05d43` on `main`.
- Linux binary SHA-256: `02905dfce9a37a2e434e4385c669da718069aa66b24bab3d7d0bb2f8112abf68`.
- Backup: `/home/eliaquin/brendy/deploy-backups/agenda-20261022T143805Z`.
- Snapshot contains 276 state/configuration files and the previous executable; archive comparison and checksums passed.
- After startup, all 343 semantic facts retained identical IDs/content/metadata except ordinary confidence-decay bookkeeping. Environment, profile, rules, personality history and embedding configuration were byte-identical.
- Service started successfully, polled Telegram, and remained active without automatic restarts. Other bot PIDs were unchanged.
- Validation: 724 tests passed; lint and TypeScript passed. Features use their default enabled settings, without editing `.env` or preloading tasks from screenshots.

The existing `update.sh` downloads the latest published release, not `main`. Until a release includes this merge, running it would replace the agenda build with an older release. Use an explicitly verified build or a release containing this commit.
