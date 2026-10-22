# Agenda and standing preferences

The bot can register explicit user requests for one-time reminders, daily or weekly messages, current-information research, and lasting source/style preferences. `ENABLE_COMMITMENTS` defaults to true; false disables capture, preference application and delivery. Simple assistant mode also disables it. This is an internal Telegram agenda, not Google Calendar integration.

## Conversation examples

- “Todos los días a las 7am dinos los resultados de ayer de la LIDOM y algo destacable. A las 10pm, los juegos de mañana. Busca en bengaleses.com y pelotainvernal.com.” Creates two research tasks with their own objectives, public search queries and source domains. The confirmation must state the actual end date.
- “De lunes a viernes a las 8am recuérdame revisar los pedidos, hasta el 15 de noviembre.” Weekends are excluded.
- “Todos los lunes a las 9am, por las próximas dos semanas…” Selects Mondays only.
- “Recuérdame el 20 de enero a las 10am llamar al taller.” One future occurrence; one-time reminders may be beyond the next month.
- “Qué tareas tienes programadas aquí”, “cancela el aviso de la mañana”, “cámbialo a las 8am”, “sigue otro mes con los resultados”. Listing, cancellation, replacement and explicit renewal use existing records. Ambiguous targets require clarification.
- “Cuando investigues pelota, usa también bengaleses.com y pelotainvernal.com.” Stores a standing source preference for that chat, independent of any task's lifetime.

Recurring tasks default to and are capped at **one calendar month from creation or explicit renewal**, even when asked to run forever. An earlier requested end date is honored through that local date. Editing a schedule replaces it with a newly bounded task and confirms the new deadline. There is no implicit extension from discussion, delivery or memory recall. One-time tasks end after their sole occurrence's one-hour delivery window. Times use the saved `BOT_TIMEZONE` (default America/Santo_Domingo). Calendar dates are resolved afresh across DST; nonexistent local times are skipped/rejected rather than moved silently.

The maximum is 10 live tasks and 20 active preferences per chat (with a 6,000-character total rendered preference budget), and three domains per task/preference. Any participant addressed to the bot in the allowed group can create their own entries; each can edit, cancel or renew their own, and `OWNER_USER_ID` can manage all entries in that chat. DMs remain owner-only. Entries never cross chat boundaries. Reconfiguration of allowed chat IDs is checked before delivery.

## Capture and confirmation

`src/commitments/requests.ts` runs a bounded JSON interpretation call on the configured background provider only for likely requests or a pending clarification. It receives the current user's original text, or their own voice-note transcript, plus existing records. It never receives an expanded page, document body, forwarded message or quoted bot promise as authorization. The model identifies intent and ambiguities; schema validation, provenance, source-domain checks, limits and ownership are enforced in code.

Unclear times, dates or goals produce a clarification without mutations. Dictated source addresses always require written links. A bare “sí” cannot satisfy that requirement. Pending clarification is scoped to both user and chat, lasts 15 minutes, and survives restart. Unrelated chat must not be interpreted as authorization. Voice-note capture does not execute instructions from someone else's replied-to audio or an uploaded audio file. The original user text remains separate from reference material in sensory memory and prompt previews.

Bare domains count as complete written addresses; users need not add `https://` or combine everything in one message. Pending requests retain typed text separately from transcriptions, allowing source links and missing details to arrive in separate messages. Extraction failures also retain the draft, so a short follow-up can retry it. Invalid model JSON gets one internal repair attempt; a mistaken request to retype already written addresses gets one reconsideration. Both remain bounded and must pass normal validation. A named official source without its URL is retained as a research requirement rather than an invented domain. Reasonable contextual interpretations (such as a daily LIDOM game-status report meaning latest results/status) are stated in the confirmation instead of requiring optional details upfront.

The entire request batch is written before the main model receives a success result. Telegram message IDs deduplicate repeated processing (500 recent receipts). Failed parsing or storage cannot produce a successful save result. The response model is instructed to confirm naturally using the persisted schedule, weekdays, timezone and actual deadline, explaining that continuing requires a new request. Natural-language interpretation and wording still depend on the model; ambiguous interpretation should be clarified rather than assumed.

## Persistence and execution

`memory/commitments.json` contains versioned, validated tasks, preferences, provenance, pending clarifications and receipts. It uses the existing atomic storage and backup mechanisms; corrupted or future-schema files fail closed. Ended/cancelled entries older than 90 days are pruned on mutation; active preferences never decay into archival. Do not run two bot processes against the same memory directory: locks are in-process, as for existing memory stores.

The lifecycle polls every 30 seconds with overlap protection and shutdown draining. Explicit 07:00 and 22:00 schedules are not clamped into the spontaneous-check-in window. `/off`, sleep hours and revoked chat access suppress delivery. An occurrence delayed more than one hour is skipped and the schedule advances to its next future occurrence; restart does not send a backlog. This is best-effort delivery, not an exact-second alarm.

Each occurrence is claimed on disk before generation. The send intent is saved before Telegram, and delivery is serialized against cancellation. Telegram has no idempotency key: an ambiguous send result is recorded as `unknown`, reported to the owner, and never automatically retried. A stale claim after a crash becomes failed/unknown rather than replayed. Generation failures are reported to the owner and skip that occurrence; provider-level retries still apply. Later occurrences continue until expiry. A failure to save conversation history after a successful send must not resend it.

Delivery uses the configured identity, adaptive personality and retrieved context to generate a natural message. Research runs a public lookup at execution time, resolves yesterday/tomorrow against that execution date, and requires citations and honesty about missing evidence. Private task details stay out of the separately stored public search query. Sources embedded in a task are retained with it; applicable standing preferences are also considered. Up to three source-specific searches plus a general fallback share the existing daily search budget and cache. These are search excerpts, not full-page visits; off-domain results cannot masquerade as evidence from a preferred site. `BRAVE_API_KEY` and enabled web search are required for useful research, otherwise the message must acknowledge that it could not verify the facts.

Standing preferences are matched by normalized topic aliases supplied during extraction. They are scoped user preferences subordinate to bot rules; they do not grant permission for unsolicited messages. A tone preference is not a schedule. Names, links and topic aliases should be checked in the natural confirmation; topic matching is deliberately bounded and does not infer every possible synonym.

## Validation

`tests/commitments.test.ts`, `tests/agenda-runner.test.ts` and `tests/commitment-integration.test.ts` cover scheduling boundaries, weekdays/DST, ownership, atomicity, restart deduplication, corruption, cancellation races, uncertain delivery, voice clarification, source searches, raw-text capture and long-page previews. Tests stub model and Telegram calls; they do not contact production or establish subjective message quality. Production observation should include confirmations and actual executions before increasing task limits.
