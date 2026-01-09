# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /usr/src/app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production

# Copy pre-built WASM modules (must be built before Docker build)
COPY dist/opus-decoder.cjs dist/opus-decoder.wasm dist/opus-decoder.wasm.map ./dist/

# Copy bundled server application
COPY dist/bundle ./dist/bundle

# Expose the port
EXPOSE 8080

# Use SIGTERM for graceful shutdown
STOPSIGNAL SIGTERM

# Start the server
CMD ["node", "dist/bundle/server.js"]
