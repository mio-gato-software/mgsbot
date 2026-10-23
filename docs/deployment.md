# Standalone deployment and upgrades

The public repository documents the application, not a particular operator's infrastructure. Host addresses, SSH aliases, account names, instance names, backup inventories, process IDs and production conversations belong in private operator records outside version control. The root `deploy-notes/` and `deploy-backups/` directories are ignored for that purpose.

## Installation layout

Run the executable from the installation directory containing its `.env` and persistent data. Relative paths resolve from that working directory. `MEMORY_DIR` can select a separate data root. Give each instance its own directory, credentials, data and service; in-process locks do not coordinate multiple bot processes against one store.

A headless installation can use `memory/bot_profile.json` and `memory/bot_rules.json`; absence of `bot_config.json` is normal in that configuration. Preserve existing profiles and memory during upgrades instead of initializing replacements. See the [README](../README.md#profile-rules-and-character-image) for first-time setup and [maintenance guide](maintenance.md) for recovery.

In the examples below, `mgsbot.service` is a generic service name. Substitute the actual service only in your private deployment configuration. The commands assume a user-level systemd unit; system-level services use the system manager instead.

```bash
systemctl --user show mgsbot.service \
  -p WorkingDirectory -p ExecStart -p FragmentPath \
  -p ActiveState -p MainPID -p NRestarts
```

## Release assets

[GitHub Releases](https://github.com/mio-gato-software/mgsbot/releases) publishes `mgsbot-linux` for Linux x64, `mgsbot-macos` for macOS ARM64 and `mgsbot-windows.exe` for Windows x64. Rename the asset to the executable name expected by your service. The binaries do not require Bun on the target machine.

Weather queries are included from [v1.0.66](https://github.com/mio-gato-software/mgsbot/releases/tag/v1.0.66), alongside the agenda and browser-backed research. Chained search/page/weather queries with up to four batches per turn are included from [v1.1.0](https://github.com/mio-gato-software/mgsbot/releases/tag/v1.1.0). Set the installation's reference location as described in [weather configuration](weather.md); that setting does not establish a participant's location.

Pushing source to `main` does not publish a release. The tag-triggered release workflow validates the source and builds all three assets before publication. An updater that queries `https://api.github.com/repos/mio-gato-software/mgsbot/releases/latest` receives the latest published release, not untagged source changes.

## Upgrade procedure

1. Identify the intended release or source commit. Validate a source build with lint, typecheck and tests. Record source identity and the executable's SHA-256 in private deployment notes; builds made with different Bun versions or flags can have different hashes.
2. Download or copy the executable to a staging filename in the installation directory. Compare the complete file's SHA-256 with the expected build hash or GitHub asset digest after transfer finishes. Run `--help`, which exits without polling. There is no `--version` flag; an unknown flag can start the application.
3. Stop only the intended service and confirm its main PID is zero. With restrictive permissions, back up the executable, service definition, `.env`, full memory directory and any instance-local updater. Verify the stopped-state archive and checksums before replacing files. Keep those records outside the public repository.
4. Atomically rename the staged executable to the name expected by the service and preserve executable permissions. Start the service. On startup failure, restore the previous executable and restart; do not automatically restore an older memory snapshot over newer conversations.
5. Check stable service PID, restart count, the running `/proc/<PID>/exe` hash, startup logs and successful Telegram polling. Compare configuration and memory with the snapshot. Normal confidence decay can change bookkeeping; existing fact identities and contents should remain intact. Check independent instances separately.

An instance-local `update.sh`, when provided by the operator, may automate downloading and replacing the executable. Inspect its repository, asset selection and rollback behavior before use. Such a script is not distributed as a repository-managed updater here and is not a substitute for a verified stopped-state backup. Publishing a release does not itself restart or replace a running bot.

The shared `/tmp/mgsbot-heartbeat` contains no instance identity and is insufficient as the sole health signal when several bots run on one host. Another instance can overwrite or remove it. Correlate polling observations with the intended service and executable, and see the pending isolation work in [TODO.md](../TODO.md).
