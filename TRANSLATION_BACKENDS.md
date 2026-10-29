# Translation Backends

The `/translate` endpoint translates speech to speech: a participant's Opus audio goes in, translated audio in the target language comes back, with the target-language transcript alongside. opus-transcriber-proxy can run it on either of two providers, chosen per deployment or per connection. This document is the `/translate` counterpart of [BACKENDS.md](BACKENDS.md), which covers the transcription backends behind `/transcribe`.

Text translation of transcripts (the `translation-result` messages on `/transcribe`, `ENABLE_TEXT_TRANSLATION`) is a different feature with its own providers; see the text translation section of [CLAUDE.md](CLAUDE.md).

## Available Backends

Both providers serve the same realtime protocol: the client sends `session.update`, `session.input_audio_buffer.append` (base64 PCM16 mono 24 kHz) and `session.close`; the server streams `session.output_audio.delta` (base64 PCM16 24 kHz) and `session.output_transcript.delta`. One `TranslatorConnection` code path serves both, and the differences are captured in a `TranslationProviderSpec` (`src/translate/provider.ts`).

### OpenAI (Default)
Uses OpenAI's `gpt-realtime-translate` model over `wss://api.openai.com/v1/realtime/translations`.

**Features:**
- Continuous output audio, streamed faster than real time
- Sentence-level transcript fragments; no transcript-done event, so the final is assembled by the proxy
- Fixed list of 13 target languages
- Purpose-built model: the session accepts only the target language, no instructions, voice or modality settings

**Configuration:**
```bash
OPENAI_API_KEY=your-key-here
OPENAI_TRANSLATION_API_KEY=       # Separate key for translation (optional; falls back to OPENAI_API_KEY)
OPENAI_TRANSLATION_MODEL=gpt-realtime-translate

# OpenAI is the default; this makes it explicit
TRANSLATION_PROVIDER=openai
```

**Supported target languages:** `en`, `es`, `pt`, `fr`, `ja`, `ru`, `zh`, `de`, `ko`, `hi`, `id`, `vi`, `it`. English names are accepted too (`spanish`). Anything else is rejected at connect, so the direction is never opened.

**Technical Details:**
- The model is a URL query parameter; the account needs tier 1+ access
- Node authenticates with the `realtime` and `openai-insecure-api-key.<key>` subprotocols; the Worker with an `Authorization: Bearer` header (never both, which OpenAI rejects)
- `session.update` is sent on socket open and audio flows at once (`handshake: 'open'`)
- The transcript final is the run's fragments concatenated, emitted at the talk-stop silence boundary and on close (`finalizePendingTranscript`)
- No idle close by default: billing is by audio duration, so a muted participant's open session costs nothing

### xAI
Uses xAI's realtime translation (`grok-realtime-translation-fast`) over `wss://api.x.ai/v1/realtime/translations`.

**Features:**
- Any BCP-47 language tag as the target (no allowlist; Dutch, Cebuano and region tags such as `pt-BR` work)
- Per-segment transcript finals from the server (`session.output_transcript.updated`)
- Output audio in one burst per source phrase, nothing during silence
- Optional TTS voice
- Faster connect than OpenAI (0.3 s against 0.5-1.5 s, measured)

**Configuration:**
```bash
XAI_API_KEY=your-key-here
XAI_TRANSLATION_API_KEY=          # Separate key for translation (optional; falls back to XAI_API_KEY)
XAI_TRANSLATION_URL=wss://api.x.ai/v1/realtime/translations   # Override the endpoint (optional)
XAI_TRANSLATION_VOICE=            # TTS voice (optional; unset = xAI's default)
TRANSLATION_IDLE_CLOSE_MS=120000  # Close a direction with no media for this long (default for xAI; 0 disables)

# Make xAI the default provider
TRANSLATION_PROVIDER=xai
```

The team behind the key needs xAI's realtime-translation entitlement. Without it every upgrade is answered `403 {"error":"Realtime translation is not enabled for this team."}`, however valid the key is otherwise.

**Supported target languages:** any tag with the BCP-47 shape (`es`, `zh-CN`, `zh-Hant`, `ceb`). The primary subtag is lowercased, the rest is sent as given. English names are accepted too.

**Technical Details:**
- The server speaks first with `session.created`; the proxy answers `session.update` and holds audio in the pending-PCM buffer until `session.updated` (`handshake: 'session'`). A handshake that does not complete within 10 s fails the direction
- Node authenticates with the `xai-insecure-api-key.<key>` subprotocol, the Worker with an `Authorization: Bearer` header. Under header auth xAI echoes no subprotocol, and a client that requested one fails the handshake, so none is requested. Under subprotocol auth xAI echoes the key subprotocol back: never log the negotiated protocol
- `session.update` carries `audio.input.transcription: false` (the bridge gets the source transcript from `/transcribe`), PCM 24 kHz in both directions, and the voice when configured
- `session.output_transcript.updated` carries a segment's whole translation, equal to the concatenated deltas (measured). It is emitted as the final at once and the delta buffer reset; the silence-timer finalization publishes nothing on xAI, since it would print each segment twice. It lands about 1.5 s after the source phrase ends and 0.3-6 s before the segment's audio, because TTS queues behind a continuous speaker, so the subtitle leads the translated speech
- Segments are short phrases endpointed at about 400 ms of silence (17-21 per 46 s of speech, measured), so captions are choppier than OpenAI's sentence-level ones
- Output audio arrives as one burst per segment at 7-900x real time; the `RtpTimestamper` lays it onto the same monotonic timeline as OpenAI's output
- The documented `segment.usage` event was never seen in testing; usage is billed from the audio the proxy appended, as for OpenAI
- The server does not answer the client's Close frame; the socket ends with 1006 about a second later, logged at debug once closed
- xAI drops a session after about 5 min without client audio and caps one at about 2 h, with no resume. Both are plain remote closes; the proxy reopens the direction on the source's next media frame
- **Idle close.** xAI bills the greater of audio duration and wall-clock session time, idle included. A direction with no media for `TRANSLATION_IDLE_CLOSE_MS` (120 s) is closed proactively, except while translated audio is still playing out, and reopened on the next frame. Without it a muted participant pays for silence and then loses the direction at xAI's own timing. The cost is on the reopen: the first frames after the silence wait for the connect (0.3 s measured) and the `session.created` / `session.update` / `session.updated` round trips before the buffered PCM flushes, so the first half second or so of speech after a long pause arrives late, buffered rather than lost

## Architecture

### Provider Selection

`TRANSLATION_PROVIDER` picks the deployment default (`openai` when unset). A connection can name its own with the `provider` URL parameter:

```
wss://host/translate?sessionId=...&provider=xai
```

Unlike `/transcribe`, there is no priority list and no fallback: every direction of a connection uses one provider, and a provider the deployment has no key for would fail every direction at connect, so the upgrade is refused early. An unknown provider is the client's error (close 1008 on the container, HTTP 400 on the Worker); a known one with no key is the deployment's (1011 / 503), which the bridge may retry.

In the Cloudflare deployment an operator can move new `/translate` sessions to the other provider without a release through the KV override (`translate:provider-override`); see the provider override section of [CLAUDE.md](CLAUDE.md).

### Provider Spec

`TranslationProviderSpec` (`src/translate/provider.ts`) is what a provider contributes:

| Field | OpenAI | xAI |
|---|---|---|
| `url` | endpoint + `?model=` | `XAI_TRANSLATION_URL` or the default endpoint |
| `protocols` | `['realtime']` | none |
| `authSubprotocolPrefix` (Node) | `openai-insecure-api-key.` | `xai-insecure-api-key.` |
| `handshake` | `open`: configure on socket open, audio at once | `session`: wait for `session.created`, then `session.updated` |
| `serverTranscriptFinals` | no: finals assembled at the talk-stop silence | yes: `session.output_transcript.updated` |
| `defaultIdleCloseMs` | 0 | 120 000 |
| `buildSessionUpdate(lang)` | `{ audio: { output: { language } } }` | input/output PCM 24 kHz, `transcription: false`, optional `voice` |

Language normalisation is per provider too: `normalizeTargetLanguage(input, provider)`.

### What Is Shared

Everything else is provider-neutral and lives in `TranslatorConnection` and `TranslatorProxy`:

- Opus decoding of the speaker's audio and Opus re-encoding of the translated PCM, with DTX so silence frames are dropped
- Talk boundaries (`talkStart` / `talkStop`) inferred from the translated voice going silent, since neither provider sends an audio boundary event
- RTP timing from the `RtpTimestamper`
- Audio levels for the bridge's ssrc-audio-level extension
- Usage reporting from the audio actually appended to the provider
- Reopening a direction whose session went away on the source's next media frame, paced after a failure or a session the provider dropped before it was usable (within 10 s of creation and under 2 s of audio); the pacing is cleared once a session has carried 2 s of audio

### Close Reasons

A `TranslatorConnection` reports why it closed, and the proxy decides from that whether and how soon to reopen:

| Reason | Meaning | Reopen |
|---|---|---|
| `local` | the proxy closed it (dropped from `sources`) | no |
| `remote` | the provider closed an established session (xAI's idle drop or session cap) | next media frame |

A `remote` close is reopened at once, unpaced: an established session that the provider ends is normally its idle drop or session cap, and pacing it would clip the first second of speech after every one. The line between the two is the connection's age at close, 30 s (`REJECTED_MAX_SESSION_AGE_MS`): a provider that accepts the handshake and drops every session a few seconds in is paced like one that refuses outright, while xAI's own closes at about 5 min and 2 h are far past the floor. What the floor does not cover is a provider that drops every session after more than 30 s; that would be re-dialled once per round trip.

A `sources` event is not "ensure every requested direction is open". It opens the directions that are new; one in its reopen backoff, or one the idle close ended, stays closed through any number of `sources` events until that source sends media, which then reopens it at once. That is deliberate: `sources` fires on every join and leave, and re-dialling on each would start a paid session for every muted participant each time. Nothing on the bridge relies on a `sources` round trip reopening a direction; the bridge only ever learns about a direction from the media and talk events it produces.
| `idle` | the proxy's idle close | next media frame, not on a `sources` event |
| `rejected` | the provider closed it within 30 s of creation | next media frame, paced 1-15 s |
| `error` | a failure (`onError` fired first) | next media frame, paced 1-15 s |

## Adding a New Backend

A provider that speaks the same `session.*` protocol needs only a spec:

1. Add its id to `TranslationProviderId` and `TRANSLATION_PROVIDERS` in `src/translate/provider.ts`, and a branch in `getTranslationProvider` returning its `TranslationProviderSpec`
2. Add its language normalisation to `normalizeTargetLanguage` and its credentials to `isTranslationProviderAvailable`
3. Add the config fields to `TranslationRuntimeConfig` (`src/translate/runtime.ts`) and resolve them in both runtimes: `src/translate/nodeRuntime.ts` (from `src/config.ts`) and `worker/translationRuntime.ts` (from the Worker env, with the variables declared in `worker/env.d.ts` and forwarded to the container in `worker/containerEnv.ts`)
4. Add it to the `translate` override slot in `worker/providerOverride.ts`, with its credential check
5. Add tests next to `test/unit/translateProvider.test.ts` and `test/unit/TranslatorConnectionXAI.test.ts`, and document it here, in README.md and in CLAUDE.md

A provider with a different wire protocol needs a second code path in `TranslatorConnection`, which has not been needed yet. Probe the provider live first: the questions that decided this design (does output audio flow during input silence, are transcript deltas cumulative or append-only, when does the final land relative to the audio) can only be answered against the real endpoint.

## Backend Comparison

Measured on the same 46 s English sample translated to Spanish, replayed through the proxy at real time.

### Latency

| Backend | Connect | First audio | Notes |
|---|---|---|---|
| OpenAI | 0.5-1.5 s | 0.9-1.8 s | continuous output, sentence-level finals |
| xAI | 0.3 s | 3.1-3.2 s | one burst per phrase, finals before the audio |

### Quality

On the sample OpenAI's translation read better and kept sentences whole; xAI produced 21 phrase-level finals against OpenAI's 6, so its captions are choppier, but it kept a technical term ("endpoint") that OpenAI translated literally. Both produced about the same amount of translated audio. Run your own sample with `scripts/replay-dump.cjs` against both before choosing.

### Cost

List prices at the time of writing:
- **OpenAI:** $0.034 per minute of audio
- **xAI:** $0.05 per minute, billed on the greater of audio duration and wall-clock session time, idle included. The idle close bounds the wall-clock part; a direction that stays open for a muted participant still costs the idle period each time it is opened

### Language Support

- **OpenAI:** 13 target languages (see above)
- **xAI:** any BCP-47 tag

The client is not told the server's list. jitsi-meet offers the 13 common languages by default and a deployment running xAI can extend the picker with `config.audioTranslation.languages`.

## Testing

```bash
# Configure the provider
XAI_API_KEY=your-key TRANSLATION_PROVIDER=xai npm run dev

# Replay the sample through /translate, translating to Spanish, saving the translated audio
node scripts/replay-dump.cjs resources/sample.jsonl \
  "ws://localhost:8080/translate?sessionId=test&sendBack=true&sendBackInterim=true&provider=xai" 1 \
  --translate=es --save-audio=/tmp/xai-es --ci
```

Unit tests: `test/unit/translateProvider.test.ts` (specs and resolution), `test/unit/TranslatorConnectionXAI.test.ts` (handshake, finals, idle close, close reasons), `test/unit/TranslatorProxy.test.ts` (reconcile, reopen, pacing). The integration matrix (`npm run test:integration -- --endpoint=translate --provider=...`) runs each provider against the live endpoint when its key is set.

## Troubleshooting

### Upgrade refused
- `Invalid translation provider` (1008 / 400): the `provider` parameter names something other than `openai` or `xai`
- `not available: its API key is not configured` (1011 / 503): set `OPENAI_API_KEY` / `XAI_API_KEY` (or the `*_TRANSLATION_API_KEY` variant) for that provider

### xAI answers 403 on every connect
The key's team lacks the realtime-translation entitlement; xAI has to enable it per team. The key itself can be valid for STT and chat and still get this.

### xAI direction fails with a handshake timeout
`session.updated` did not arrive within 10 s of `session.created`. Check the `session.update` payload against xAI's current schema (a rejected field is answered with an `error` event, logged as `xAI sent error message`).

### Directions keep closing and reopening on xAI
Every 120 s for a muted participant is the idle close working as intended. Every ~5 min for a participant who is talking means the audio is not reaching xAI; check the decoder and the `session.updated` gate.

### Translated audio stutters
Both providers deliver audio faster than real time in bursts; the `RtpTimestamper` lays it onto a continuous timeline and the bridge plays it out. See the talk-boundary and `RtpTimestamper` notes in CLAUDE.md.
