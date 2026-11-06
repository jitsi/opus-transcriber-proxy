# Audio decoding and the Opus codec

_Split out of `CLAUDE.md`; see the task table there for which of these documents to read. Keep this file current in the same commit as the code it describes._

## Opus backends

There are **two** interchangeable low-level Opus codec backends, selected at runtime via
`OPUS_BACKEND` (`config.opus.backend`):

- **`wasm`** (default) — Emscripten/WebAssembly build. Required when running in a Cloudflare
  Worker (no native addons); needs Emscripten to build the `.wasm` artifacts.
- **`native`** — libopus N-API addon (`build/Release/opus_native.node`). Container-only, faster;
  needs a C/C++ toolchain. Opt in with `OPUS_BACKEND=native`.

`OpusDecoder`/`OpusEncoder` are facades that dynamically import only the selected backend, so a
native deployment never loads the WASM files and a WASM deployment never requires the addon.

### Prerequisites

- **WASM backend**: Emscripten (emsdk) + autotools (`autoconf`/`automake`/`libtool`/`make`) to
  build libopus, plus the `src/OpusDecoder/opus` submodule.
- **Native backend**: a C/C++ compiler (`clang`/`gcc` + `g++`), `make`, `python3` (node-gyp), plus
  the submodule.
  - macOS: `xcode-select --install`; Debian/Ubuntu: `apt-get install build-essential python3`;
    Alpine (container): `apk add python3 make g++`.
- Submodule: `git submodule update --init src/OpusDecoder/opus`.

## Decoder and encoder components

**AudioDecoder** (`src/AudioDecoder.ts`)
- Interface for format-agnostic audio decoding with chunk-sequence tracking
- `decodeChunk()` returns `DecodedAudio[]` (with `audioData: Uint8Array`) or `null` for out-of-order packets
- `DecodedAudio.kind` distinguishes `'normal'` from `'concealment'` frames (for metrics)
- `DecodedAudio.samplesDecoded` is 0 for non-PCM pass-through (`PassThroughDecoder`)
- Implementations: `OpusAudioDecoder`, `L16Decoder`, `PassThroughDecoder`

**AudioDecoderFactory** (`src/AudioDecoderFactory.ts`)
- `createAudioDecoder(inputFormat, outputFormat)` selects the right decoder
- Returns `PassThroughDecoder` when output is raw Opus or Ogg (no decoding needed)
- Returns `L16Decoder` when input is already l16 and output is l16 (resample or pass-through)
- Returns `OpusAudioDecoder` when input is Opus and PCM output is required

**OpusAudioDecoder** (`src/OpusDecoder/OpusAudioDecoder.ts`)
- Implements `AudioDecoder` with packet-loss concealment logic
- Wraps the low-level `OpusDecoder`; handles gap detection and concealment frames
- Decodes Opus frames to mono PCM at a configurable output rate (default 24kHz; 16kHz when requested by the xAI backend). Supported rates: 8/12/16/24/48kHz

**L16Decoder** (`src/L16Decoder.ts`)
- Implements `AudioDecoder` for raw PCM l16 input
- If input and output sample rates match, frames are forwarded unchanged; otherwise resampled via linear interpolation
- Still performs out-of-order packet detection; validates even byte length before resampling

**PassThroughDecoder** (`src/PassThroughDecoder.ts`)
- Implements `AudioDecoder` without actual decoding
- Forwards raw Opus or Ogg frames unchanged; still performs out-of-order packet detection
- `samplesDecoded` is always 0 (no PCM to count)

**OpusDecoder** (`src/OpusDecoder/OpusDecoder.ts`)
- Low-level decoder **facade**: picks the native or WASM backend at runtime (`config.opus.backend` / `OPUS_BACKEND`) and dynamically imports only that one, so the other backend's module is never evaluated (no stray native-addon require or WASM file-read)
- Public API unchanged: `new OpusDecoder({ sampleRate, channels })`, `ready`, `decodeFrame`, FEC/PLC `conceal`, `reset`, `free`. Init is async (behind `ready`) because the backend is dynamically imported
- Backends: `OpusDecoderNative.ts` (libopus N-API addon via `nativeOpus.ts`) and `OpusDecoderWasm.ts` (Emscripten); both implement `IOpusDecoder` (`opusTypes.ts`)
- Used by `OpusAudioDecoder` and `TranslatorConnection`; not used directly by `OutgoingConnection`

**OpusEncoder** (`src/OpusEncoder/OpusEncoder.ts`)
- Low-level encoder **facade**, symmetric to `OpusDecoder`: selects `OpusEncoderNative.ts` or `OpusEncoderWasm.ts` (both implement `IOpusEncoder`, `opusEncoderTypes.ts`) via `OPUS_BACKEND`, dynamic-importing only the chosen one
- Public API unchanged: `new OpusEncoder(config)`, `ready`, `encodeFrame` (one Opus packet per 20 ms frame), `getFrameSize`, `getFrameSizeBytes`, `free`
- Each `EncodedFrame` carries `data`, `inDtx` and `audioLevel` — the RFC 6464 level (0 = full scale .. 127 = silence, in -dBov) of the PCM frame that was encoded, computed by both backends in their per-frame loop via `computeAudioLevel` (`src/OpusEncoder/audioLevel.ts`: one pass over the 480 samples plus one `log10`, about a microsecond, negligible next to the encode). It is computed in TypeScript rather than in the C shim/addon so there is one implementation, unit-testable without a codec build; libopus exposes no signal-level output of its own. It **matches libwebrtc's `RmsLevel`** (the level Chrome sends in the extension) frame for frame, including libwebrtc's rule that 127 means digital silence only and a non-silent frame at or below -127 dBov reports 126 (`AUDIO_LEVEL_INAUDIBLE`; unreachable at 480-sample frames, whose quietest non-silent level is 117). `test/unit/audioLevelWebrtc.test.ts` pins this against `test/fixtures/webrtc-audio-level/vectors.json`, produced by the real libwebrtc `rms_level.cc` compiled into `harness.cc` over the shared corpus in `test/helpers/audioLevelCorpus.ts`; `generate.mts` there regenerates it from a WebRTC checkout
- Used by `TranslatorConnection` to re-encode translated PCM back to Opus

**nativeOpus** (`src/OpusDecoder/nativeOpus.ts`)
- Loads the compiled N-API addon `build/Release/opus_native.node` (via `createRequire`,
  probing a few known locations so it works under tsx and the esbuild bundle). Only imported when `OPUS_BACKEND=native`
- Exports typed `NativeOpusDecoder` / `NativeOpusEncoder` interfaces and `OPUS_APPLICATION`

## Audio encoding notes

- Client sends Opus frames (raw or Ogg-Opus container)
- `OutgoingConnection` calls `backend.getDesiredAudioFormat(inputFormat)` to determine what the backend wants
- `AudioDecoderFactory.createAudioDecoder(inputFormat, outputFormat)` then creates the right decoder:
  - `PassThroughDecoder` when output encoding is `'opus'` or `'ogg'` (no decode/re-encode)
  - `L16Decoder` when input encoding is `'l16'` and output encoding is `'l16'` (resample or identity)
  - `OpusAudioDecoder` when input is Opus and output encoding is `'l16'` (decode to PCM)
- PCM format: 24kHz, 16-bit, mono (`audioData` is a `Uint8Array` of raw PCM bytes)
- Deepgram can accept raw Opus to avoid decode/re-encode
- `OutgoingConnection.updateInputFormat()` calls `reinitializeDecoder()` when the format changes. If `backend.getDesiredAudioFormat(newInputFormat)` returns a different encoding than the one the backend was connected with, `reinitializeDecoder` closes the old backend and opens a fresh one (`reconnectBackend`) before creating the decoder. The generation counter (`reinitGeneration`) ensures concurrent calls are safe: `activeDesiredFormat` is set synchronously so concurrent calls immediately see the new target format.

## Invariants

- Opus has two backends selected by `OPUS_BACKEND` (default `wasm`): WASM (Emscripten, `build:wasm`, needs Emscripten + the `src/OpusDecoder/opus` submodule) and native (node-gyp N-API addon, `build:native`, needs a C/C++ toolchain + python3 + the submodule). `OpusDecoder`/`OpusEncoder` are facades that dynamically import only the selected backend. If `native` fails to load at runtime, confirm `build/Release/opus_native.node` exists (`npm run build:native`) and that `src/OpusDecoder/nativeOpus.ts`'s candidate paths resolve; if `wasm` fails, confirm `dist/opus-*.{cjs,wasm}` exist (`npm run build:wasm`). The Docker image ships both; the container default is `wasm` (set `OPUS_BACKEND=native` to opt in).
- SIMD is selected at runtime (libopus RTCD on x86; NEON baseline on aarch64). Never add `-msse*`/`-mavx*` to the base `libopus` target or to global cflags — those flags must stay confined to their per-ISA static_library targets in `binding.gyp`, or the addon may execute instructions the CPU lacks.
- Deepgram (`DEEPGRAM_ENCODING`, default `opus`, raw Opus or Ogg) and xAI (`XAI_ENCODING=opus`, raw Opus only, default `l16`) support pass-through: Deepgram returns a copy of the input format from `getDesiredAudioFormat()`, xAI a constant Opus format, when pass-through applies. The old `wantsRawOpus()` method has been replaced by `getDesiredAudioFormat()`.
- `DecodedAudio.audioData` is a `Uint8Array` of raw bytes (PCM for decoded audio, raw frames for pass-through). The old `pcmData: Int16Array` field no longer exists.
- When adding a new backend, implement `getDesiredAudioFormat(inputFormat): AudioFormat`. Return `{ encoding: 'l16', sampleRate: 24000 }` for PCM or `{ ...inputFormat }` (shallow copy) for raw pass-through. Do not return the `inputFormat` reference directly. This method is called on every `reinitializeDecoder` call (not just once at construction), so it must be a pure function of `inputFormat` for a given backend configuration. If the method has connect-time side effects (like `DeepgramBackend` storing `negotiatedFormat`), it will also be called on any new backend instance before `connect()`, so those side effects will be applied correctly.
- `AudioFormat.encoding` is a lowercase union type: `'opus' | 'ogg' | 'l16'`. The client-facing `'ogg-opus'` value is normalised to `'ogg'` by `validateAudioFormat()`, and all incoming encodings are lowercased before validation so case-insensitive client values are accepted.
- `OggOpusDecapsulator` only requires an `OpusHead` packet when its first page is a beginning-of-stream page (Ogg `header_type & 0x02`). If the first page seen is a non-BOS page — which happens when a client reconnects and resumes an existing Ogg stream mid-way after a server/container restart, without replaying the headers — it logs a warning and decodes from that point instead of throwing. This matters for any backend that requests `l16` from `ogg` input (e.g. xAI always, Deepgram with `DEEPGRAM_ENCODING=linear16`), which routes audio through `CascadedDecoder(OggOpusDecapsulator → OpusAudioDecoder)`. Backends on the pass-through path (`PassThroughDecoder`) never hit this validation.

## Environment variables

- `OPUS_BACKEND` - Opus codec backend: `wasm` (default; required in a Worker) or `native` (libopus addon, container-only, faster)
