# Memory maintenance and recovery

The default data root is `./memory`. Set `MEMORY_DIR` before startup to use another directory. The application resolves this once after loading its environment; do not change it while the process runs. Tests force a disposable root in `tests/preload.ts`, independently of inherited configuration.

## Persistence contract

Stores accept legacy payloads without `schemaVersion` and the current v1 format. Successful writes validate both the existing file and the new payload. Missing files represent initial state; malformed JSON, invalid payloads, unreadable files, and unsupported schema versions raise an error. The damaged original remains in place. In-process locks serialize read/modify/write operations. Asynchronous atomic writes use unique temporary names, flush file contents, then rename.

Run only one bot process against a data root. Locks coordinate this process, not multiple processes or manual edits made concurrently with it.

## Promotion recovery

Sensory overflow is journaled in `promotion-spool/<chat_id>.json` before its messages are removed. Entries retain their original timestamps and importance policy. If the process exits between the journal write and sensory removal, the retry worker removes only matching source messages before applying the promotion.

The worker checkpoints its generated episode, facts, user-evidenced confirmations, and personality signals before applying them. Full media text stays in sensory memory and the spool until extraction succeeds; only chat prompt previews are compacted. Facts and episodes are saved immediately. Relationship and chapter updates normally batch four promotions from the same month; importance-4/5 episodes and inactivity wipes flush immediately. The startup/hourly retry job flushes smaller pending batches, and an active drain also flushes entries waiting at least an hour. Shutdown leaves pending batches durably journaled for startup. `prepared.effectsApplied` means only narrative work remains. Generated narrative updates and their batch membership are checkpointed before narrative writes. Stable IDs and persisted receipts make replay safe after partial commits: episodes, semantic merges, personality changes, relationship counts, and chapter membership are not applied twice. If later promotions have changed a narrative store, a retry regenerates its still-unapplied summary from the current state before saving it. The entry is removed only after all effects succeed. Proactive messages use the same overflow path.

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

Confidence decay is checked hourly and runs once per bot-local day. Facts below 0.1 confidence are marked `archivedAt` and retained as historical evidence; they leave routine subject context but remain eligible for relevant vector/keyword retrieval, with an explicit historical-age annotation. Superseded facts stay excluded. Genuine reconfirmation and retrieval reinforcement remain distinct: extraction can return `confirmedFacts` IDs with verbatim user evidence, checked against the presented fact IDs and actual user messages, and applied once per promotion. Retrieval alone never resets confirmation clocks or unarchives a fact.

Permanent facts have no storage-count cap. Retrieval selects up to 25 by relevance and participant names. All memory prompt sections share a 12,000-character ceiling with per-section allowances; limits never truncate stored data. Older chapters are selected from the retained 18 months by explicit English/Spanish month, YYYY-MM date, year, or keyword relevance; two are injected, with recent chapters as the fallback. Already deleted facts and already truncated transcripts cannot be reconstructed automatically.

The janitor persists successful cluster fingerprints in `janitor-reviews.json`, skipping unchanged clusters on subsequent days/restarts. Invalid model structures fail and remain eligible for a later review. `/optimize` remains available for an explicit confidence-decay/archive pass.

`bun run memory:stats` (or `--json`) reports operation/model call counts, observed retries/fallbacks, available input/output/cached/reasoning tokens, embedding-cache hits, and memory prompt characters from `metrics/usage-YYYY-MM.jsonl`. Counts contain no conversation text. Usage telemetry shares `PROMOTION_METRICS` and `PROMOTION_METRICS_RETENTION_MONTHS` controls. Unknown provider usage is left unset; chat-provider fallback exposes only text, and SDK-internal retries may be invisible. Treat token totals as reported usage, not a complete invoice. Gemini reasoning tokens are a separate output component; OpenAI reasoning tokens are included in output tokens. Retain `promote:stats` for gate calibration and extraction quality; tune promotion thresholds only after reviewing production samples.

Run `bun run lint:fix`, `bun run typecheck`, and `bun test --coverage` before delivery. Integration tests inject providers and Telegram delivery; they require no real provider traffic. The full API defaults remain in the provider metadata registry. Conversation options are named, retrieval is shared with check-ins, and response marker parsing is separate from delivery.
