# Identity sidecar — Node + sherpa-onnx-node (native) + baked ONNX models.
# Build for the Cloudflare Containers runtime arch: docker build --platform linux/amd64 .
# (sherpa-onnx-node ships prebuilt native binaries per platform; the arch must match the runtime.)

# ---- build: install deps, compile TS, fetch models ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
# Speaker-embedding (CAM++, 3D-Speaker) + segmentation (pyannote-3.0) ONNX models.
RUN mkdir -p models \
  && curl -fL -o models/campplus.onnx \
     https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx \
  && curl -fL -o /tmp/seg.tar.bz2 \
     https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 \
  && tar xjf /tmp/seg.tar.bz2 -C /tmp \
  && cp /tmp/sherpa-onnx-pyannote-segmentation-3-0/model.onnx models/segmentation-3.0.onnx \
  && rm -rf /tmp/seg.tar.bz2 /tmp/sherpa-onnx-pyannote-segmentation-3-0

# ---- runtime: prod deps + compiled output + models ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
ENV EMBEDDING_MODEL=/app/models/campplus.onnx \
    SEG_MODEL=/app/models/segmentation-3.0.onnx \
    PORT=8090
EXPOSE 8090
CMD ["node", "dist/src/server.js"]
