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
# Baked from the host build context (arch-independent, like the WASM artifacts) rather than
# curl'd in-build: the buildkit/QEMU builder's network to github.com is unreliable, and copying
# is deterministic and makes rebuilds faster. Fetch the source models with scripts/fetch-models.sh.
COPY models ./models

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
