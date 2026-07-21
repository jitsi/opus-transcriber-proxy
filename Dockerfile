# syntax=docker/dockerfile:1

# The image ships BOTH Opus backends so a container can run either at runtime via OPUS_BACKEND
# (default 'wasm'; set OPUS_BACKEND=native for the libopus addon).
#
# - The native addon is architecture-specific, so it is compiled in-container (per target platform).
# - The WASM artifacts are architecture-independent and are built on the host/CI (npm run build:wasm)
#   and copied in. They are NOT built here: emscripten/emsdk is amd64-only, so building WASM in the
#   image would run under QEMU emulation on arm64 and be far too slow. `npm run docker:build` builds
#   them first; CI does the same before `docker build`.

# Base is Debian (bookworm-slim, glibc) — NOT Alpine — because the in-container identity path
# uses sherpa-onnx-node, whose prebuilt native binaries are built against glibc (no musl variant
# is published). On Alpine/musl the sherpa .so fails to dlopen at runtime. The identity sidecar
# uses the same base for the same reason. libopus/node-gyp build fine on Debian.

# ---- Builder: compile the native Opus addon and bundle the server ----
FROM node:22-bookworm-slim AS builder
WORKDIR /usr/src/app

# Toolchain for node-gyp + libopus (C/C++).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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
FROM node:22-bookworm-slim AS runtime
WORKDIR /usr/src/app

# libstdc++6 (needed by the compiled C++ addon and by sherpa-onnx) ships in the Debian base.

# Production dependencies only. --ignore-scripts avoids any native rebuild
# (binding.gyp is intentionally not present in this stage). Optional platform deps
# (incl. sherpa-onnx-linux-<arch>, glibc prebuilt) are still installed.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Native Opus addon + bundled server, compiled in the builder stage.
COPY --from=builder /usr/src/app/build/Release/opus_native.node ./build/Release/opus_native.node
COPY --from=builder /usr/src/app/dist/bundle ./dist/bundle

# Prebuilt, architecture-independent WASM artifacts (from the build context; built by build:wasm).
COPY dist/opus-decoder.cjs dist/opus-decoder.wasm dist/opus-encoder.cjs dist/opus-encoder.wasm ./dist/

# CAM++ speaker-embedding model for the in-container identity path (LocalIdentityClient -> embedder,
# sherpa-onnx-node). Architecture-independent, so it is fetched on the host (npm run fetch-models)
# and baked in via COPY — like the WASM artifacts. Only used when Vectorize creds are configured;
# harmless otherwise. sherpa-onnx-node itself is a prod dependency installed above (its platform
# binary is a prebuilt optional dep, so --ignore-scripts is fine — no native build needed).
COPY models/campplus.onnx ./models/campplus.onnx
ENV EMBEDDING_MODEL=/usr/src/app/models/campplus.onnx
# So the sherpa-onnx native addon can resolve its sibling shared libraries (libonnxruntime.so, ...)
# in the prebuilt platform package. CF Containers run linux/amd64 -> sherpa-onnx-linux-x64.
ENV LD_LIBRARY_PATH=/usr/src/app/node_modules/sherpa-onnx-linux-x64

# Expose the port
EXPOSE 8080

# Use SIGTERM for graceful shutdown
STOPSIGNAL SIGTERM

# Start the server
CMD ["node", "dist/bundle/server.js"]
