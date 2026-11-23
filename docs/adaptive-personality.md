# Adaptive personality: observed failure and bounded correction

Earlier adaptive updates could saturate multiple traits at the upper limit and could learn from interactions between other people instead of feedback directed at the bot. Production conversation excerpts, instance identities and personality snapshots are not included in this public explanation.

Previously, each extracted delta was added directly to the trait value. Momentum was updated but did not affect the value or the prompt. The three prompt tiers meant that additional positive updates after 0.67 produced identical instructions; at 1.0 they did not even change the stored value. The configured identity and manually written style rules also remained in the prompt, so numerical updates alone could not establish a visible behavioral difference.

The implementation now:

- Requires extraction to identify direct-to-bot feedback and provide a verbatim user quote. Promotion checks that quote against the user's own message, excluding quoted bot preambles and fetched page content. This grounds evidence; whether the feedback truly implies a lasting change still depends on the extractor.
- Rejects nonfinite deltas and repeated entries for the same trait in one update.
- Uses a 70/30 moving average of bounded feedback to drive slow convergence toward a target between 0.15 and 0.85, rather than accumulating deltas forever. Stored legacy values are not reset; later evidence gradually changes them.
- Applies a 30-day half-life toward neutral both when updating and when rendering. Prompt rendering does not rewrite historical state. Neutral tendencies emit no instructions, and modest deviations have a direction relative to the configured baseline.
- Keeps configured identity, explicit boundaries, chat preferences and the current situation above adaptive tendencies. High humor does not require jokes in a serious exchange.
- Supports `ENABLE_ADAPTIVE_PERSONALITY=false` to stop new adaptive signals, their application and their prompt section while retaining configured personality and existing history.

These behavioral instructions preserve existing personality history. Unit tests validate convergence, decay, reversal, provenance and replay safety. A production comparison for conversational quality remains in `TODO.md`.

## Group relationships and initiative

Set `ENABLE_GROUP_PERSONALITY=true` to enable relationship-aware tone, spontaneous participation and willingness decisions in Telegram groups. Existing installations keep their previous four-hour spontaneous reply cadence by default.

Group members start with a neutral relationship. The bot learns familiarity from reciprocal exchanges and adjusts its tone based on the member's observed treatment of the bot and other participants. It applies personal or topic-specific limits immediately. Relationship state is saved under `memory/group-relationships/` by chat and Telegram member ID. The conversation prompt receives only the current speaker's tone cues. Sensitive or serious moments call for restraint at every level.

The group router can admit an unprompted comment or playful quip. A successful intervention starts the `GROUP_SPONTANEOUS_COOLDOWN_MINUTES` pause, which defaults to 60 minutes. A separate 10-minute attempt limit covers silence and failed deliveries. Existing exchanges use the continuation window.

The bot can decline a new favor before carrying out the work. The original requester can bring it up again within 15 minutes. The decision uses the original request and the new reason, with the existing creator and chat permissions applied at execution. Recent refusals and retry receipts are stored under `memory/group-requests/` by chat for recovery across a restart.

Enabling the feature adds a model assessment for authored group messages and can add a willingness check for requests. A low-confidence proposed change may trigger a focused confirmation. With an OpenAI key, `CLASSIFIER_PROVIDER` defaults to OpenAI Decisions. Set `CLASSIFIER_PROVIDER=typesafe` to select Jev with a TypeSafe key. Relationship and willingness assessments can fall back to the configured background model under a separate deadline.
