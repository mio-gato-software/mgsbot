# TODO — Known Pending Work

Living document. Rules:

- **Before starting maintenance work**, scan this file — an item here may already describe the task, its context, and its prerequisites.
- **When you finish an item**, delete it (git history is the archive). Don't mark it "done" and leave it.
- **When you discover follow-up work** you are not doing right now, add it here with enough context that someone (or some agent) can pick it up cold: why it matters, what blocks it, suggested approach, date added.
- Keep entries honest about size and risk. "Small" means under an hour with tests passing.

## Pending

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

## Time-sensitive

### Re-verify 2027 holidays against the official Ministerio de Trabajo calendar

- **Due:** When the official 2027 calendar is announced (typically late in the prior year).
- **Why:** The `2027:` entry in `src/holidays.ts` (added 2026-07-10) applies Ley 139-97 weekday rules deterministically; the official announcement occasionally deviates (and a bill excluding Jan 6/26 from the movable list was in the legislature as of 2026).
- **Size:** Small.
- Added 2026-07-10.

