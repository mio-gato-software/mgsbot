# Weather queries and location configuration

Available from [v1.0.66](https://github.com/mio-gato-software/mgsbot/releases/tag/v1.0.66), the bot can request current conditions and hourly forecasts from [Open-Meteo](https://open-meteo.com/en/docs), using its [geocoding API](https://open-meteo.com/en/docs/geocoding-api) to resolve place names. Queries work with every chat provider and need neither Brave nor Browserbase nor a new API key. They are enabled by default; set `ENABLE_WEATHER_LOOKUP=false` to disable conversational and scheduled research queries. Ambient weather for conversation and image context remains available separately.

## Installation reference

The reference location supplies ambient weather and a default for questions with no place. It is an installation setting, not a claim about any chat participant's location. Without settings, the original Santo Domingo coordinates remain the default. No location is inferred from a user's IP address, language or nationality.

For the Dominican installation, no change is necessary. An explicit configuration is:

```dotenv
WEATHER_CITY=Santo Domingo
WEATHER_COUNTRY=DO
BOT_TIMEZONE=America/Santo_Domingo
```

A Chilean installation can use:

```dotenv
WEATHER_CITY=Santiago, Chile
WEATHER_COUNTRY=CL
BOT_TIMEZONE=America/Santiago
```

Only `WEATHER_CITY` is needed when its name/qualifier resolves clearly. `WEATHER_COUNTRY` is an optional two-letter ISO country preference, inferred from the reference city when omitted. `BOT_TIMEZONE` controls the bot's own clock, sleep and schedules; forecast interpretation uses the destination's automatic timezone independently.

For a precise point, set both `WEATHER_LATITUDE` and `WEATHER_LONGITUDE`; coordinates take priority over the geocoded city. Remove old coordinate settings when changing to city-only configuration. A single coordinate, invalid coordinates or an invalid country code are rejected instead of silently mixing settings. With coordinates, country inference requires a matching named location within approximately half a degree on each axis. For coordinate-only installations without a city name, set `WEATHER_COUNTRY` if regional preference is wanted.

Restart after changing environment settings. Ambient cache entries include the location configuration, so the previous city's saved conditions are not reused after a change.

## Resolving conversational places

1. An explicit city/country or a place established in the recent conversation takes priority. “¿Y mañana?” should keep the previous place.
2. A bare city is searched first within `WEATHER_COUNTRY`, or the country inferred from the installation reference. Thus Santiago resolves locally in both Dominican and Chilean installations. An explicit country or comma-qualified place bypasses this default.
3. If there is no match in the preferred country, the service searches globally. A failed regional request is reported as a failure, rather than being treated as an empty result.
4. The service selects a single match or a clearly dominant city (at least 100,000 inhabitants and ten times the next candidate's population), preferring populated-place entries over other geographic features. Other competing matches produce a clarification, with up to five candidates, before requesting a forecast.
5. Without a conversational place, the reference location is used and the bot is instructed to name it in its answer. It must not claim the participant is there. If the reference cannot be resolved, ask for a city/country; an explicit destination can still be queried without a working reference.

Examples: “¿Va a llover en Santiago?”, “Me refiero a Santiago de Chile”, “¿Cómo estará esta noche en San Pedro de Macorís?”, “¿Y mañana por la tarde?” and “¿Qué temperatura habrá a las ocho?”. The conversation model interprets the request and retains the place from chat history; resolution and weather retrieval happen in application code. There is no separate per-user location store or extra classifier on ordinary turns.

## Time and forecast limits

Queries cover one local calendar day at a time: today and the following six days. Relative day offsets are resolved after locating the destination, using its timezone, so “tomorrow” is not calculated using the server's date. Explicit dates outside this range produce an out-of-range result. Broader multi-day questions need a selected day.

Current conditions include temperature, humidity, wind and a weather description. Forecasts provide hourly temperature, rain probability, precipitation, wind and descriptions in °C, km/h and mm. Morning covers 06:00–12:00, afternoon 12:00–18:00, evening 18:00–21:00 and night 18:00–24:00; a specific hour selects one hourly slot. Today's expired hourly slots are excluded. If the requested period has elapsed or no usable data is available, the bot reports that instead of inventing values. Night does not include the next day's early morning; ask for that date/hour explicitly.

Rain probabilities remain per-hour probabilities; their maximum is not presented as the probability of rain over an entire period. Missing measurements remain unknown, not zero. Forecasts are not certainties, and a retrieval timestamp is not the model's issue time or the time of an observation.

The model is instructed to preserve an event's verified start time, including minutes, date and timezone, in answers and follow-ups. Forecast timestamps do not change that schedule. For a 19:30 start, it should query a period covering the surrounding hours and describe the 19:00 and 20:00 data as nearby forecasts, without inventing a 19:30 probability or calling 19:00 the start. If only one nearby slot is available, it should state that slot's actual time and the coverage limit. Timezone conversions must preserve the same instant, including any change of calendar date. These are generation instructions, not a deterministic validator of the model's wording.

## Execution and caching

`WEATHER_LOOKUP` shares a provider-independent conversational loop with `WEB_SEARCH` and `WEB_READ`. Up to four sequential lookup batches are allowed per incoming turn, with at most five model calls total. After each result the model can answer, ask a necessary clarification, or request the next tool using the earlier evidence. Ordinary conversation needs only one model call, with no extra classifier. Chained lookups are available from [v1.1.0](https://github.com/mio-gato-software/mgsbot/releases/tag/v1.1.0); `v1.0.66` supports the earlier single-batch flow.

For “¿Va a llover para el juego de esta noche?”, the model can verify which game is intended, its venue and local date/time, optionally read a calendar page, then request Open-Meteo for that place/hour. Missing or ambiguous game details require clarification rather than an invented venue or the installation reference. City weather approximates a stadium's conditions; it does not establish whether a roof is open or a game will be cancelled. The tool still selects a single hour or the existing fixed periods, not an arbitrary event-duration interval.

Only the first short notice is delivered before lookup. Subsequent decisions receive the original conversation and accumulated, labeled untrusted evidence with request parameters, source links and available timestamps/timezones. The existing character/language prompt is retained. Only the conversation and delivered final answer enter sensory memory, not raw API data, intermediate tool requests or notices. The existing world-context service can still cache search/page evidence separately.

Limits are enforced in application code, without provider-specific native function calling:

- Four lookup batches across all three tools, including failed attempts; at most five model calls. A batch can perform multiple HTTP requests (geocoding plus forecast, preferred-source searches, or up to three page reads). Existing persisted daily search/page attempt limits and caches still apply.
- A 150-second total deadline, including initial generation and cached context. New planning/lookups stop with 30 seconds left for the final response. Model decisions have at most 60 seconds, batches at most 45 seconds, shortened by the remaining budget. Parent cancellation and shutdown propagate; a cancelled batch cannot keep opening subsequent pages. A final-model failure yields an honest fallback; an overall/parent timeout uses the existing conversation timeout handling.
- At most 32,000 additional characters of transient lookup context, including up to 4,000 cached characters, request metadata and the initial notice. Each tool result contributes at most 8,000 characters. Truncation is labeled; omitted content remains unknown. The loop closes early if there is insufficient room for another useful result.
- Malformed, mixed, oversized or disabled control requests do not execute. Normalized repeated requests stop the chain even if their notices differ. Page visits, including automatic source reads, are reused within the turn. A final response containing another tool request is replaced by a fallback instead of leaking control blocks or promising unexecuted work.
- Tool parameters are limited to public search terms, public URLs and place/time arguments. Obvious emails, identifiers, credential-bearing URLs, private home paths and configured secrets are blocked before dispatch. This deterministic backstop cannot identify every private fact: prompt instructions also prohibit sending private memories or chat details, and retrieved content cannot authorize new actions. Existing public-address/redirect checks and read-only page access remain in force.

When a cap, failure or missing dependency prevents completion, the model is instructed to explain what remains unverified or ask a brief clarification. Failed forecasts never fall back to another city's ambient weather.

This tool runs on incoming conversational turns, including simple assistant mode. Scheduled research in `src/commitments/runner.ts` uses its existing web-search/page-reading evidence path and does not invoke `WEATHER_LOOKUP`. A scheduled weather request therefore does not automatically use the structured Open-Meteo query described here. Proactive messages also retain their existing ambient context rather than running this conversational tool.

Geocodes are cached in memory for 24 hours and forecasts for 15 minutes, each bounded to 100 entries. Forecasts are refreshed at the destination's date boundary to preserve the seven-day horizon. Both caches reset on restart. Requests use fixed Open-Meteo endpoints, validated parameters, a 512 KB response limit, 10-second per-request signals and a 25-second total lookup deadline. There are no automatic weather-query retries. Ambient weather retains its existing cache by part of day in `memory/daily-weather.json`.

Unavailable services, invalid responses and unresolved locations are passed to the final generation as missing evidence. The bot is instructed to report the limitation, link Open-Meteo for successful findings, and never substitute the reference city's ambient conditions for the requested forecast.

## Scheduled reports

Research tasks share the bounded lookup loop with chat turns: up to four lookup batches, with a time and evidence budget. When requested, the model resolves current event locations and start times and calls the hourly forecast service. Scheduled lookups require an explicit location rather than silently using the installation reference. Unknown venues or postponed fixtures without a new confirmed start cannot receive a reliable game-time forecast. Unavailable probability is reported as unknown. Source-omission preferences still apply, and no intermediate lookup notices are sent to the chat. Personal reminders do not use this loop.
