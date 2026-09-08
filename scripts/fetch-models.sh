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

# NB: "recongition" is the actual upstream release tag (typo in the tag name, not ours).
CAMPPLUS_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
# SHA-256 of the known-good model. The download has no integrity guarantee otherwise, and a swapped
# ONNX file could execute arbitrary code via ONNX Runtime custom ops — so we verify before baking it.
CAMPPLUS_SHA256="aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"

# Portable sha256 (Linux CI has sha256sum; macOS has shasum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

verify() {
  local got; got="$(sha256_of models/campplus.onnx)"
  if [ "$got" != "$CAMPPLUS_SHA256" ]; then
    echo "ERROR: models/campplus.onnx SHA-256 mismatch" >&2
    echo "  expected $CAMPPLUS_SHA256" >&2
    echo "  got      $got" >&2
    return 1
  fi
}

if [ -f models/campplus.onnx ]; then
  # Re-verify a cached copy; a corrupt/tampered one is removed and re-fetched rather than trusted.
  if verify; then
    echo "models/campplus.onnx already present and verified; skipping."
    exit 0
  fi
  echo "Cached model failed verification — re-fetching." >&2
  rm -f models/campplus.onnx
fi

echo "Fetching CAM++ speaker-embedding model..."
curl -fL -o models/campplus.onnx "$CAMPPLUS_URL"
verify
echo "Done: models/campplus.onnx (sha256 verified)"
