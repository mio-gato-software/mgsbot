# TODO — Known Pending Work

Living document. Rules:

- **Before starting maintenance work**, scan this file — an item here may already describe the task, its context, and its prerequisites.
- **When you finish an item**, delete it (git history is the archive). Don't mark it "done" and leave it.
- **When you discover follow-up work** you are not doing right now, add it here with enough context that someone (or some agent) can pick it up cold: why it matters, what blocks it, suggested approach, date added.
- Keep entries honest about size and risk. "Small" means under an hour with tests passing.

## Time-sensitive

### Re-verify 2027 holidays against the official Ministerio de Trabajo calendar

- **Due:** When the official 2027 calendar is announced (typically late in the prior year).
- **Why:** The `2027:` entry in `src/holidays.ts` (added 2026-07-10) applies Ley 139-97 weekday rules deterministically; the official announcement occasionally deviates (and a bill excluding Jan 6/26 from the movable list was in the legislature as of 2026).
- **Size:** Small.
- Added 2026-07-10.

