# Integration test matrix

Exercises the real server/worker process (not vitest mocks): starts the container or Worker,
replays [`resources/sample.jsonl`](../../resources/sample.jsonl) at full speed via
[`scripts/replay-dump.cjs`](../../scripts/replay-dump.cjs) `--ci`, and asserts on what comes back.
Orchestrated per-cell by [`scripts/integration-test.mjs`](../../scripts/integration-test.mjs).

## Dimensions

| Dimension | Values | Notes |
|---|---|---|
| `runtime` | `container`, `worker` | `container` = plain `docker run` of the image, all endpoints. `worker` = `wrangler dev`, **`/translate` only** — see below. |
| `opus-backend` | `wasm`, `native` | Selects `OPUS_BACKEND`. **Container only**: the one `worker` cell is `/translate`, which always runs the Worker-isolate WASM codec path (no `OPUS_BACKEND` involved at all). |
| `endpoint` | `transcribe`, `translate` | `/transcribe` (multi-provider) vs `/translate` (speech-to-speech, OpenAI only). |
| `provider` | `dummy`, `openai`, `deepgram`, `xai` | Only meaningful for `transcribe`; `translate` is hardcoded to the OpenAI Realtime translation model, so its only "provider" cell is `openai`. Gemini is deliberately excluded from this harness (not from the product) to keep the per-PR matrix smaller. |

## `runtime: worker` is `/translate`-only by design

The Worker *can* route `/transcribe` too (via the Container binding in `worker/index.ts`), but
production never does — only `/translate` is deployed through the Worker. This harness matches
that: the only `worker` cell is `{opusBackend: wasm, endpoint: translate, provider: openai}`. A
`worker` + `/transcribe` cell would also need Docker (`wrangler dev` builds the container image
itself on startup), which is redundant with the `container` cells above and has been unreliable on
at least one constrained local machine — not worth covering a path production doesn't use.

## The `dummy` provider is a wiring smoke test, not a transcript test

[`DummyBackend`](../../src/backends/DummyBackend.ts) decodes and counts audio but never calls
`onInterimTranscription`/`onCompleteTranscription` — it cannot produce a transcript. Its cells
assert only the `--ci` baseline (clean connect, no WebSocket error, clean close), which still
catches real regressions: decoder crashes, backend wiring breaks, format-negotiation errors. It
needs no API key, so it's the only provider that runs unconditionally.

The three real providers assert `--assert-min-finals=1` on `/transcribe`. `/translate` (OpenAI only)
asserts `--assert-min-media=1` (translated Opus audio came back) — transcript output from
`/translate` is not gated on, since `TRANSLATE_TRANSCRIPTS` can legitimately be turned off.

## Full cell list (11)

| # | runtime | opus-backend | endpoint | provider | requires |
|---|---|---|---|---|---|
| 1 | container | wasm | transcribe | dummy | — |
| 2 | container | wasm | transcribe | openai | `OPENAI_API_KEY` |
| 3 | container | wasm | transcribe | deepgram | `DEEPGRAM_API_KEY` |
| 4 | container | wasm | transcribe | xai | `XAI_API_KEY` |
| 5 | container | native | transcribe | dummy | — |
| 6 | container | native | transcribe | openai | `OPENAI_API_KEY` |
| 7 | container | native | transcribe | deepgram | `DEEPGRAM_API_KEY` |
| 8 | container | native | transcribe | xai | `XAI_API_KEY` |
| 9 | container | wasm | translate | openai | `OPENAI_API_KEY` |
| 10 | container | native | translate | openai | `OPENAI_API_KEY` |
| 11 | worker | wasm | translate | openai | `OPENAI_API_KEY` |

(`worker` × `transcribe` is excluded entirely — see above. `translate` × `{deepgram,xai}` is
excluded — translation only supports OpenAI. Gemini is excluded from this harness entirely, see the
dimensions table above.)

If a cell's required API key isn't set in the environment, `scripts/integration-test.mjs`
soft-skips it (logs `SKIP: ... not set`, exits 0) rather than failing — this lets the same 11-cell
list run with a partial key set locally and a full set in CI.

## Running a cell locally

```bash
# Prebuild once (container cells need the image; both cells need the wasm dist artifacts):
npm run build:wasm
npm run docker:build   # ships both opus backends, see Dockerfile

OPENAI_API_KEY=sk-... node scripts/integration-test.mjs \
  --runtime=container --opus-backend=wasm --endpoint=transcribe --provider=openai
```

`--runtime=worker` shells out to `wrangler dev` directly; only `--endpoint=translate` is covered
here (no prebuilt image needed — `/translate` runs entirely in the Worker isolate).

## CI

See [`.github/workflows/integration-test.yml`](../../.github/workflows/integration-test.yml): a
`build-artifacts` job builds the WASM dist files and the Docker image once and shares them via
upload/download-artifact, then a matrix job runs all 11 cells (soft-skipping any without a secret).
Runs on every PR into `main` and on `workflow_dispatch` — accepted cost/flake tradeoff for catching
integration regressions before merge; the matrix was trimmed (Gemini dropped) partly to keep that
tradeoff reasonable.
