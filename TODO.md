# TODO — Known Pending Work

Living document. Rules:

- **Before starting maintenance work**, scan this file — an item here may already describe the task, its context, and its prerequisites.
- **When you finish an item**, delete it (git history is the archive). Don't mark it "done" and leave it.
- **When you discover follow-up work** you are not doing right now, add it here with enough context that someone (or some agent) can pick it up cold: why it matters, what blocks it, suggested approach, date added.
- Keep entries honest about size and risk. "Small" means under an hour with tests passing.

## Time-sensitive

### Add 2027 holidays to `src/holidays.ts`

- **Due:** January 2027 (the calendar only has 2026; `isHoliday()` returns false for unknown years, so nothing crashes — the bot just loses holiday awareness).
- **Approach:** Add a `2027:` entry following the existing format. Dominican Republic movable holidays follow Ley 139-97 (some holidays move to the nearest Monday) — verify each date, don't copy the 2026 offsets.
- **Size:** Small.
- Added 2026-06-11.

### Runtime smoke test of `@google/genai` 2.x

- **Why:** The 1.x → 2.8.0 major upgrade (2026-06-11) is verified by typecheck and unit tests only — no test exercises real Gemini API calls.
- **What to verify before the next release:** one text exchange (chat), a voice note (STT via Gemini), an image sent to the bot (vision), `[IMAGE: ...]` generation, and that embeddings still produce 768-dim vectors (check `memory/embedding-cache.json` grows).
- **Rollback if anything misbehaves:** `bun add @google/genai@1.52.0`.
- **Size:** Small (manual session with the running bot).
- Added 2026-06-11.

## Refactors with prerequisites

### Extract voice/photo handlers from `src/handlers.ts`

- **Why:** `handlers.ts` is ~1,000 lines mixing voice, audio, photo, and text handlers. Group state was already extracted to `src/group-state.ts` (2026-06-11); the media handlers are the remaining large chunk.
- **Blocked by:** A grammY mock harness. The handlers are entangled with ~10 shared routing helpers (`routeGroupTranscribedVoice`, `processConversationAndTrackGroupContinuation`, mention detection, reply-context builders) and no test covers handler-level behavior — extracting without that safety net is high risk for no urgent gain.
- **Approach when picked up:** First build a minimal grammY `Context` mock + tests pinning the routing decisions (DM vs group, mention types, passive voice gating). Then move handlers one at a time: photo first (most self-contained), voice last.
- **Size:** Large (multi-session).
- Added 2026-06-11.

### Review `getLastSendTime()` semantics in `src/follow-ups.ts`

- **Why:** The loop compares `fu.detectedAt > lastSent` but assigns `lastSent = fu.scheduledFor` — it compares one field against a value taken from another. With multiple sent follow-ups the "most recent" pick can be wrong, which would let the 2-hour send cooldown misfire. Low real-world impact (max 2 sends/day caps the damage).
- **Approach:** Decide what "last send time" should mean (probably: actual send moment — which is recorded nowhere today; `scheduledFor` is the closest proxy). Either compare and assign the same field, or record a real `sentAt` on send. `tests/follow-ups.test.ts` pins current behavior — update it deliberately with the fix.
- **Size:** Small.
- Added 2026-06-11.

## Nice to have

### Coverage reporting in CI

- **Why:** Coverage exists locally (`bun test --coverage`) but nothing tracks it over time. Target-module coverage went from 0% to 30–71% in the 2026-06 test push; without CI visibility it can silently regress.
- **Approach:** Add a `bun test --coverage` step (or flag on the existing test step) in `.github/workflows/ci.yml`. Optionally enforce a floor via `bunfig.toml` (`[test] coverageThreshold`), starting low (e.g. 20%) and raising it as coverage grows.
- **Size:** Small.
- Added 2026-06-11.

### Promote handler magic numbers to named constants

- **Why:** A few tuning values remain inline in `src/handlers.ts` (e.g. the 500-char reply-context truncation) and similar constants are duplicated across modules (`ACTIVE_CONVERSATION_MS` exists in both `follow-ups.ts` and `check-ins.ts`).
- **Approach:** Only worth doing opportunistically while touching those files — not as a standalone pass.
- **Size:** Small.
- Added 2026-06-11.
