# Weather queries and location configuration

The bot can request current conditions and hourly forecasts from [Open-Meteo](https://open-meteo.com/en/docs), using its [geocoding API](https://open-meteo.com/en/docs/geocoding-api) to resolve place names. Queries work with every chat provider and need neither Brave nor Browserbase nor a new API key. They are enabled by default; set `ENABLE_WEATHER_LOOKUP=false` to disable conversational queries. Ambient weather for conversation and image context remains available separately.

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

## Execution and caching

`WEATHER_LOOKUP` uses the existing provider-independent two-pass conversational lookup flow. The first generation chooses a tool and a short notice; the notice is delivered before the request. The second generation answers using transient evidence and the existing character/language prompt. One turn permits one weather, search or page-reading batch and at most one additional generation. Mixed/malformed requests do not execute; repeated tool blocks are removed from the final reply. Only the conversation and final answer enter sensory memory, not raw API data or control blocks.

Geocodes are cached in memory for 24 hours and forecasts for 15 minutes, each bounded to 100 entries. Forecasts are refreshed at the destination's date boundary to preserve the seven-day horizon. Both caches reset on restart. Requests use fixed Open-Meteo endpoints, validated parameters, a 512 KB response limit, 10-second per-request signals and a 25-second total lookup deadline. There are no automatic weather-query retries. Ambient weather retains its existing cache by part of day in `memory/daily-weather.json`.

Unavailable services, invalid responses and unresolved locations are passed to the final generation as missing evidence. The bot is instructed to report the limitation, link Open-Meteo for successful findings, and never substitute the reference city's ambient conditions for the requested forecast.
