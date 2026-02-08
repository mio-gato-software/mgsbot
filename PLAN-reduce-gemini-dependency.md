# Plan: Reduce Gemini Dependency

## Problem

Currently, even when `CHAT_PROVIDER` is set to `openrouter`, `anthropic`, or `azure`, the app still requires `GOOGLE_API_KEY` and calls Gemini directly for **6 core functions** in `src/ai.ts`. This means Gemini is always a hard dependency regardless of which chat provider is selected.

## Hard Gemini Dependencies (in `src/ai.ts`)

| Function | Gemini Model Used | What It Does |
|---|---|---|
| `transcribeAudio()` | gemini-3-flash-preview | Transcribes voice/audio messages via Gemini Files API |
| `describeImage()` | gemini-3-flash-preview | Describes photos/images sent by users |
| `analyzeYouTube()` | gemini-3-flash-preview | Analyzes YouTube video content |
| `summarizeConversation()` | gemini-3-flash-preview | Rolls up old messages into a summary |
| `evaluateMemory()` | gemini-3-flash-preview | Extracts long-term memories and member facts from conversations |
| `generateImage()` | gemini-3-pro-image-preview | Generates character images (weekly feature) |

Additionally:
- `src/prompt.ts` imports `type Content` from `@google/genai` (used by `buildContents()`)
- `src/weather.ts` exports a `FunctionDeclaration` type from `@google/genai` (only used by Gemini provider)

## Goal

When a non-Gemini provider is selected, the app should work **without** `GOOGLE_API_KEY` and without any `@google/genai` calls.

---

## Changes Required

### 1. Route `summarizeConversation()` and `evaluateMemory()` through the active chat provider

**Why:** These are pure text-in/text-out tasks. Any LLM can do them.

**How:**
- Change `summarizeConversation()` to call `generateResponse()` (which already delegates to the active provider) instead of calling `ai.models.generateContent()` directly.
- Change `evaluateMemory()` the same way: call `generateResponse()` with the prompt instead of Gemini directly.
- Both functions just send a text prompt and parse the text response, so no Gemini-specific features are needed.

**Files:** `src/ai.ts`

### 2. Route `transcribeAudio()` through the active chat provider (with fallback)

**Why:** Most modern LLMs support audio/multimodal input via OpenAI-compatible APIs. For providers that don't, we can use a dedicated STT service.

**Options (pick one):**
- **Option A — OpenAI-compatible Whisper endpoint:** Use OpenAI's `/v1/audio/transcriptions` API (or a compatible service like Groq Whisper). Add `WHISPER_API_KEY` + `WHISPER_API_URL` env vars. This keeps transcription independent of the chat provider.
- **Option B — Keep Gemini as optional fallback:** If `GOOGLE_API_KEY` is set, use current Gemini transcription. Otherwise, use a Whisper-compatible endpoint. This is the least disruptive option.
- **Option C — Provider-based multimodal:** Extend the `ChatProvider` interface with an optional `transcribeAudio()` method. Providers that support multimodal can implement it natively. Others fall back to Whisper.

**Recommended: Option A** (cleanest separation; Groq Whisper is free/cheap and fast).

**Files:** `src/ai.ts`, possibly new `src/transcription.ts`, `.env.sample`

### 3. Route `describeImage()` through the active chat provider

**Why:** Image description is a multimodal text task. Most providers (Anthropic, OpenRouter models, Azure) support vision.

**How:**
- Extend `ChatProvider` interface with an optional method: `describeImage?(imageBase64: string, mimeType: string, prompt: string): Promise<string>`
- Implement it in each provider using their native vision API:
  - **Anthropic:** Supports `image` content blocks with base64 in the Messages API
  - **OpenRouter:** Supports OpenAI-compatible vision (image_url with base64 data URI)
  - **Azure:** Supports vision via the same OpenAI-compatible format
  - **Gemini:** Keep current implementation
- In `ai.ts`, `describeImage()` checks if the active provider has vision support; if so, delegates to it. Otherwise, falls back to Gemini (if API key present) or returns a placeholder.

**Files:** `src/providers/types.ts`, `src/providers/anthropic.ts`, `src/providers/openrouter.ts`, `src/providers/azure.ts`, `src/providers/gemini.ts`, `src/ai.ts`

### 4. Route `analyzeYouTube()` through the active chat provider (or disable)

**Why:** YouTube analysis currently uses Gemini's ability to ingest video via URI. This is a Gemini-specific feature; other providers cannot process raw YouTube URLs the same way.

**Options:**
- **Option A — Graceful degradation:** When non-Gemini provider is active, skip YouTube analysis and just include the URL in the message text. The LLM may still know about the video from training data.
- **Option B — YouTube transcript extraction:** Use a library like `youtube-transcript` or `ytdl-core` to fetch the video transcript, then pass it as text to the active chat provider for analysis. This gives similar results without needing Gemini's video ingestion.
- **Option C — Keep Gemini as optional fallback:** If `GOOGLE_API_KEY` is available, use Gemini for YouTube. Otherwise, fall back to transcript extraction or skip.

**Recommended: Option B** (best UX without Gemini dependency).

**Files:** `src/ai.ts`, possibly new `src/youtube.ts`, `package.json` (new dependency)

### 5. Handle `generateImage()` — Gemini-only or disable

**Why:** Image *generation* is fundamentally different from text tasks. Gemini's `gemini-3-pro-image-preview` generates images from text+reference. There's no direct equivalent in Anthropic/OpenRouter/Azure chat APIs.

**Options:**
- **Option A — Disable image generation when not on Gemini:** Set a flag; when the provider is non-Gemini and no `GOOGLE_API_KEY` is present, suppress the `[IMAGE: ...]` marker logic entirely. Log a warning at startup.
- **Option B — Alternative image gen service:** Integrate an alternative like OpenAI DALL-E, Stability AI, or Replicate. Add `IMAGE_GEN_PROVIDER` + `IMAGE_GEN_API_KEY` env vars.
- **Option C — Keep Gemini as optional image gen backend:** If `GOOGLE_API_KEY` is present, use it for image gen regardless of chat provider. Otherwise, disable the feature.

**Recommended: Option C** (image gen is a weekly nice-to-have, not critical; keeping it optional is pragmatic).

**Files:** `src/ai.ts`, `src/handlers.ts` (guard the image gen logic)

### 6. Decouple `src/weather.ts` types from `@google/genai`

**Why:** `weatherTool` is typed as `FunctionDeclaration` from `@google/genai`. This creates an import dependency even though the weather data fetch itself (Open-Meteo) has nothing to do with Gemini.

**How:**
- Define a local interface for the tool declaration in `src/weather.ts` instead of importing from `@google/genai`.
- In `src/providers/gemini.ts`, cast or adapt the local type to Gemini's `FunctionDeclaration` where needed.
- Optionally, implement function/tool calling in other providers too (Anthropic and OpenRouter both support it).

**Files:** `src/weather.ts`, `src/providers/gemini.ts`

### 7. Remove `Content` type dependency from `src/prompt.ts`

**Why:** `buildContents()` returns `Content[]` from `@google/genai`. This ties the prompt builder to Gemini's type system.

**How:**
- Define a local `ContentMessage` interface in `src/providers/types.ts` that matches the shape needed (role + parts).
- Use this local type in `prompt.ts` instead of Gemini's `Content`.
- In `src/providers/gemini.ts`, map from the local type to Gemini's `Content` if needed.
- Other providers already use `ChatMessage[]` from `buildMessages()`, so `buildContents()` may only need to exist for the Gemini provider.

**Files:** `src/prompt.ts`, `src/providers/types.ts`, `src/providers/gemini.ts`

### 8. Environment variable changes

- `GOOGLE_API_KEY`: Change from required to **optional** (only required if `CHAT_PROVIDER=gemini` or if image generation is desired)
- New env vars (depending on choices above):
  - `WHISPER_API_KEY` + `WHISPER_API_URL` (if Option A for transcription)
  - `IMAGE_GEN_PROVIDER` + `IMAGE_GEN_API_KEY` (if Option B for image gen)
- Update `.env.sample` with new vars and document which are optional

**Files:** `.env.sample`, `CLAUDE.md`

---

## Summary of Recommended Approach

| Feature | Strategy | Gemini Needed? |
|---|---|---|
| Chat responses | Already provider-agnostic | No |
| Summarize conversation | Route through active provider | No |
| Evaluate memory | Route through active provider | No |
| Consolidate member facts | Already uses `generateResponse()` | No |
| Audio transcription | Whisper-compatible API (new) | No |
| Image description | Provider vision APIs (extend interface) | No |
| YouTube analysis | Transcript extraction + active provider | No |
| Image generation | Keep Gemini as optional backend | Optional |
| Weather function calling | Decouple types, keep Gemini-only for now | Only with Gemini provider |
| TTS | Already uses LemonFox (no Gemini) | No |

## Implementation Order

1. `summarizeConversation()` + `evaluateMemory()` — easiest wins, pure text
2. Type decoupling (`prompt.ts` Content type, `weather.ts` FunctionDeclaration)
3. `describeImage()` — extend ChatProvider with vision support
4. `transcribeAudio()` — add Whisper integration
5. `analyzeYouTube()` — add transcript extraction
6. `generateImage()` — add guards for optional Gemini usage
7. Update env vars, `.env.sample`, and `CLAUDE.md`
