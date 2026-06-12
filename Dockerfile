# syntax=docker/dockerfile:1

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
RUN npm run build:bundle

# ---- Runtime: slim image with only production deps + built artifacts ----
FROM node:22-alpine AS runtime
WORKDIR /usr/src/app

# libstdc++ is required at runtime by the compiled C++ addon.
RUN apk add --no-cache libstdc++

# Production dependencies only. --ignore-scripts avoids any native rebuild
# (binding.gyp is intentionally not present in this stage).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Native Opus addon + bundled server, copied from the builder stage.
COPY --from=builder /usr/src/app/build/Release/opus_native.node ./build/Release/opus_native.node
COPY --from=builder /usr/src/app/dist/bundle ./dist/bundle

# Expose the port
EXPOSE 8080

# Use SIGTERM for graceful shutdown
STOPSIGNAL SIGTERM

# Start the server
CMD ["node", "dist/bundle/server.js"]
