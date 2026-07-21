#!/usr/bin/env bash
# Fetch the CAM++ speaker-embedding ONNX model into ./models so the Dockerfile can COPY it.
# The in-container identity path (LocalIdentityClient -> embedder) embeds speaker audio with
# this model. It is architecture-independent (like the WASM opus artifacts), so it is fetched
# once on the host and baked into the image via COPY — not curl'd inside the (QEMU,
# unreliable-network) buildkit build. Run from the repo root or anywhere: `npm run fetch-models`.
#
# NOTE: only the CAM++ embedding model is needed here. Diarization/segmentation (pyannote) runs
# on the transcription backend now, not in this container, so no segmentation model is fetched.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p models

CAMPPLUS_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"

if [ -f models/campplus.onnx ]; then
  echo "models/campplus.onnx already present; skipping (delete it to re-fetch)."
  exit 0
fi

echo "Fetching CAM++ speaker-embedding model..."
curl -fL -o models/campplus.onnx "$CAMPPLUS_URL"

echo "Done: models/campplus.onnx"
