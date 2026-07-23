# syntax=docker/dockerfile:1

# The image ships BOTH Opus backends so a container can run either at runtime via OPUS_BACKEND
# (default 'wasm'; set OPUS_BACKEND=native for the libopus addon).
#
# - The native addon is architecture-specific, so it is compiled in-container (per target platform).
# - The WASM artifacts are architecture-independent and are built on the host/CI (npm run build:wasm)
#   and copied in. They are NOT built here: emscripten/emsdk is amd64-only, so building WASM in the
#   image would run under QEMU emulation on arm64 and be far too slow. `npm run docker:build` builds
#   them first; CI does the same before `docker build`.

# ---- Builder: compile the native Opus addon and bundle the server ----
FROM node:22-alpine AS builder
WORKDIR /usr/src/app

# Toolchain for node-gyp + libopus (C/C++).
RUN apk add --no-cache python3 make g++ git

# Install all dependencies (incl. dev: node-gyp, node-addon-api, esbuild).
# binding.gyp is copied afterwards so this install does not trigger a build.
COPY package.json package-lock.json* ./
RUN npm ci

# Sources required to compile libopus + the addon and to bundle the server.
# src/ carries the libopus submodule (src/OpusDecoder/opus) that node-gyp builds.
COPY binding.gyp build.mjs ./
COPY native ./native
COPY src ./src

# Compile build/Release/opus_native.node, then bundle dist/bundle/server.js.
RUN npm run build:native
# GIT_HASH is baked into the bundle (build.mjs -> __GIT_HASH__) so the running commit is observable
# in the server `info` message. .git isn't in the build context, so pass it as a build-arg (CI sets
# it to the commit SHA); falls back to "unknown" for a plain `docker build`.
ARG GIT_HASH=unknown
RUN GIT_HASH="$GIT_HASH" npm run build:bundle

# ---- Runtime: slim image with production deps + both backends' artifacts ----
FROM node:22-alpine AS runtime
WORKDIR /usr/src/app

# libstdc++ is required at runtime by the compiled C++ addon.
RUN apk add --no-cache libstdc++

# Production dependencies only. --ignore-scripts avoids any native rebuild
# (binding.gyp is intentionally not present in this stage).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Native Opus addon + bundled entrypoints (proxy server + monitor), compiled in the builder stage.
COPY --from=builder /usr/src/app/build/Release/opus_native.node ./build/Release/opus_native.node
COPY --from=builder /usr/src/app/dist/bundle ./dist/bundle

# Monitor mode (node dist/bundle/monitor.js) replays a sample Opus dump against a target
# /transcribe URL. Ship the replay client it spawns and the sample dump. Unused by the default
# server CMD; `ws` (used by the replay client) is already among the production deps above.
COPY scripts/replay-dump.cjs ./scripts/replay-dump.cjs
COPY resources/sample.jsonl ./resources/sample.jsonl

# Prebuilt, architecture-independent WASM artifacts (from the build context; built by build:wasm).
COPY dist/opus-decoder.cjs dist/opus-decoder.wasm dist/opus-encoder.cjs dist/opus-encoder.wasm ./dist/

# Expose the port
EXPOSE 8080

# Use SIGTERM for graceful shutdown
STOPSIGNAL SIGTERM

# Start the server
CMD ["node", "dist/bundle/server.js"]
