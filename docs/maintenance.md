# Memory maintenance and recovery

The default data root is `./memory`. Set `MEMORY_DIR` before startup to use another directory. The application resolves this once after loading its environment; do not change it while the process runs. Tests force a disposable root in `tests/preload.ts`, independently of inherited configuration.

## Persistence contract

Stores accept legacy payloads without `schemaVersion` and the current v1 format. Successful writes validate both the existing file and the new payload. Missing files represent initial state; malformed JSON, invalid payloads, unreadable files, and unsupported schema versions raise an error. The damaged original remains in place. In-process locks serialize read/modify/write operations. Asynchronous atomic writes use unique temporary names, flush file contents, then rename.

Run only one bot process against a data root. Locks coordinate this process, not multiple processes or manual edits made concurrently with it.

## Promotion recovery

Sensory overflow is journaled in `promotion-spool/<chat_id>.json` before its messages are removed. Entries retain their original timestamps and importance policy. If the process exits between the journal write and sensory removal, the retry worker removes only matching source messages before applying the promotion.

The worker checkpoints its generated episode, facts, and personality signals before applying them. Generated narrative updates are checkpointed before narrative writes. Stable IDs and persisted receipts make replay safe after partial commits: episodes, semantic merges, personality changes, relationship counts, and chapter membership are not applied twice. If later promotions have changed a narrative store, a retry regenerates its still-unapplied summary from the current state before saving it. The entry is removed only after all effects succeed. Proactive messages use the same overflow path.

After ten failed attempts, the entry remains with `failed: true`, and the owner is alerted. To recover a paused entry:

1. Stop the bot and preserve a copy of the spool file.
2. Inspect the logged error and fix its cause (provider configuration, permissions, or invalid stored data).
3. Set that entry's `attempts` to `0` and remove its `failed` field. Preserve its ID, messages, and any `prepared` checkpoint.
4. Restart the bot. Startup retries pending entries; failed retries remain inspectable.

Do not delete a prepared entry to retry its messages as a new chunk: that discards the identity used to avoid repeated effects.

## Backups and restoration

Startup awaits a verified daily snapshot before embedding or personality migrations and before confidence decay. Subsequent backup checks run hourly. Snapshots live in `backups/YYYY-MM-DD/`; `.complete.json` records content hashes. Temporary files and the regenerable embedding cache are excluded. Snapshot copying coordinates with asynchronous persistence in the bot so a journal and its stores are captured at one persistence boundary.

Only verified staging copies are renamed into the dated location. Interrupted staging directories are not completed backups. Legacy or incomplete dated directories are preserved under a hidden `.incomplete` name when replaced. Seven dated snapshots are retained; preserved incomplete directories are for manual inspection and cleanup.

A restoration drill should copy a snapshot into a separate directory, verify its manifest using `verifyMemoryBackup(path)` from `src/memory-backup.ts`, and read the stores using their schemas from `src/memory/schemas.ts`. The backup tests exercise this without touching live data. Hash validation verifies the copy's integrity; it does not establish that the original application's data was semantically correct.

For actual recovery, stop the bot, preserve the damaged data root, and restore a verified snapshot as a complete set into a new root. Validate it before restarting with that root. Restoring only one file can discard promotion receipts while retaining other effects. Keep an independently managed copy outside the runtime volume; the repository's local snapshots cannot protect against loss of that volume. Links are preserved as links, so their external targets need separate backup coverage.

## Lifecycle and verification

`BackgroundTasks` owns recurring jobs, suppresses overlapping runs of the same job, and tracks background work for shutdown. Shutdown stops timers and polling, drains tracked work, and flushes the embedding cache. The existing ten-second watchdog still bounds shutdown; unfinished promotions survive in the journal when it expires.

Confidence decay is checked hourly and runs once per bot-local day. Genuine reconfirmation and retrieval reinforcement retain their distinct behavior. `/optimize` remains available for an explicit maintenance pass.

Run `bun run lint:fix`, `bun run typecheck`, and `bun test --coverage` before delivery. Integration tests inject providers and Telegram delivery; they require no real provider traffic. The full API defaults remain in the provider metadata registry. Conversation options are named, retrieval is shared with check-ins, and response marker parsing is separate from delivery.
