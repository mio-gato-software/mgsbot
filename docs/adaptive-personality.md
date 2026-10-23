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

These are behavioral steering instructions, not model fine-tuning or human emotional development. Unit tests validate convergence, decay, reversal, provenance and replay safety. They cannot demonstrate that users will perceive better or more natural conversations. A production comparison with adaptation on/off remains in `TODO.md`; global trait state still spans chats, so relationship-specific adaptation is a possible later improvement if real evaluation supports it. The correction preserves existing personality history instead of resetting it.
