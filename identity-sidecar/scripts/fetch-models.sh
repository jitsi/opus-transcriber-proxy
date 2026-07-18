#!/usr/bin/env bash
# Fetch the speaker-identity ONNX models into ./models so the Dockerfile can COPY them.
# These artifacts are architecture-independent (like the proxy's WASM build), so they are
# fetched once on the host and baked into the image via COPY — not curl'd inside the (QEMU,
# unreliable-network) buildkit build. Run from the identity-sidecar directory.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p models

CAMPPLUS_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
SEG_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"

echo "Fetching CAM++ speaker-embedding model..."
curl -fL -o models/campplus.onnx "$CAMPPLUS_URL"

echo "Fetching pyannote-3.0 segmentation model..."
curl -fL -o /tmp/seg.tar.bz2 "$SEG_URL"
tar xjf /tmp/seg.tar.bz2 -C /tmp
cp /tmp/sherpa-onnx-pyannote-segmentation-3-0/model.onnx models/segmentation-3.0.onnx
rm -rf /tmp/seg.tar.bz2 /tmp/sherpa-onnx-pyannote-segmentation-3-0

echo "Done: models/campplus.onnx, models/segmentation-3.0.onnx"
