# TODO — Known Pending Work

Living document. Rules:

- **Before starting maintenance work**, scan this file — an item here may already describe the task, its context, and its prerequisites.
- **When you finish an item**, delete it (git history is the archive). Don't mark it "done" and leave it.
- **When you discover follow-up work** you are not doing right now, add it here with enough context that someone (or some agent) can pick it up cold: why it matters, what blocks it, suggested approach, date added.
- Keep entries honest about size and risk. "Small" means under an hour with tests passing.

## Pending

### Preserve reference layouts for recurring report images

- **Why:** the report renderer receives a reusable design description and current report data. A legacy task that says “use the same reference design” without describing it can retain its canvas and delivery settings, but those fields cannot reconstruct the reference's layout.
- **What to do:** when a stable reference design is explicitly requested, bind a reusable, chat-scoped layout to the task on capture. Check that unrelated edits keep it and that later renders use current results, without copying dates or scores from the reference. An old reference that is no longer available must be supplied again for an exact match.
- **Size:** Medium. Added 2026-11-18.

### Check deduplication candidate coverage in multi-participant chats

- **Why:** the first participant can fill the extractor's saved-fact list before later participants are considered. Corrections or confirmations later in the same block may lack the relevant prior facts.
- **What to do:** compare the current selector with one that shares the existing candidate budget across participants and categories. Test paraphrased corrections, confirmations and deduplication across participants, preserving chat scope. Use representative traffic to calibrate recall and compare input usage.
- **Size:** Small once representative examples are available.
- Added 2026-11-17.

### Add explicitly authorized conversation observations for conditional behaviors

- **Why:** conditional behaviors support scheduled reports and independent finite watches of public events. Ordinary conversations are not event evidence.
- **What to do:** define what explicit opt-in would allow a chat observation to trigger delivery, then reuse the evaluator and receipts. Preserve source provenance, permissions, finite terms and budgets.
- **Size:** Medium; the shared evaluation and receipt infrastructure is available.
- Added 2026-11-07.

### Avoid inferring event delays from city weather alone

- **Why:** a live model test correctly distinguished the event schedule from hourly forecasts, but separately described a delay as very likely based only on city rain forecasts. Weather evidence alone does not establish an operational decision or its probability.
- **What to do:** tighten generation guidance and evaluate event-weather answers against unsupported delay/cancellation predictions. Require event-specific evidence for those claims; retain ordinary descriptions of forecast rain risk. Keep live evaluation traces private.
- **Size:** Small.
- Added 2026-10-23.

### Evaluate adaptive personality against actual conversation quality

- **Why:** earlier adaptive updates could saturate traits and learn from interactions between other people. The implementation now requires direct, verbatim user evidence, uses bounded smoothing with 30-day half-life toward neutral, and keeps configured identity/context above adaptive tendencies. Unit tests establish these mechanics, not whether responses feel noticeably better. Keep any evaluation conversations and deployment-specific results private.
- **What to do:** after deployment, compare matched serious, playful, repeated-question and explicit-boundary scenarios with adaptation enabled and disabled. Include the group personality switch when evaluating the new member-specific rapport, boundaries and spontaneous cadence. Assess appropriateness and naturalness, and monitor rejected/accepted evidence, repeated saturation and cross-chat tone transfer. Preserve live personality history during comparisons.
- **Size:** Medium; needs representative conversations and human evaluation. `ENABLE_ADAPTIVE_PERSONALITY=false` provides an operational comparison/disable switch.
- Added 2026-10-22.

### Calibrate the promotion bars from recorded data

- **Why:** `PROMOTION_MIN_IMPORTANCE` (2) and `PASSIVE_PROMOTION_MIN_IMPORTANCE` (3) were picked a priori. Every promotion decision is now recorded to `memory/metrics/promotion-YYYY-MM.jsonl`, so the bars can be set from what they actually dropped instead of intuition — a bar that's too high silently loses context whose value only shows up weeks later.
- **What to do:** after a few weeks of traffic, run `bun run promote:stats`. Read the passive counterfactual table (what each bar would keep) and the "chunks the bar dropped" tail. If dropped passive chunks look like things the bot should have remembered, lower `PASSIVE_PROMOTION_MIN_IMPORTANCE` to 2 in `.env` and re-check; if kept passive chunks are mostly noise, raise it. Update the defaults in `src/memory/promotion-policy.ts` once a bar proves itself.
- **Size:** Small (reading a report + an env change); the waiting is the cost.
- Added 2026-07-24.

### Confirm extraction quality held after the move to `gemini-3.6-flash`

- **Why:** background memory work (fact extraction, narrative updates, janitor) is pinned to a cheap model, and cheap background work is worthless if it starts storing garbage. The metrics now track parse failures, facts per chunk, validator-rejected facts, and empty extractions per model, and a daily check alerts the owner when a model degrades — but there is no *baseline* yet, so the first weeks of data are the baseline.
- **What to do:** run `bun run promote:stats` after a couple of weeks and record the per-model numbers here (or in the commit message) so the next model swap has something to be compared against. Spot-check a handful of episodes/facts in `memory/` by hand: the metrics catch a model that stops answering, not one that answers plausibly but wrong.
- **Size:** Small.
- Added 2026-07-24.

### Confirm recurring storage of external production snapshots

- **Why:** an external recovery drill verified snapshot contents. Continued protection depends on copying newly verified snapshots outside the runtime volume on a recurring basis.
- **What to do:** confirm the off-volume destination, schedule, retention and monitoring for every production instance. Run `bun run backup:verify` against a fresh external copy and keep instance details in private operational records.
- **Size:** Small once the external destination is known.
- Added 2026-11-17.

## Time-sensitive

### Re-verify 2027 holidays against the official Ministerio de Trabajo calendar

- **Due:** When the official 2027 calendar is announced (typically late in the prior year).
- **Why:** The `2027:` entry in `src/holidays.ts` (added 2026-07-10) applies Ley 139-97 weekday rules deterministically; the official announcement occasionally deviates (and a bill excluding Jan 6/26 from the movable list was in the legislature as of 2026).
- **Size:** Small.
- Added 2026-07-10.
