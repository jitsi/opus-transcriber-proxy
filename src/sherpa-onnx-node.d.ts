// sherpa-onnx-node ships no TypeScript types; treat it as untyped.
// Wrapped behind src/identity/embedder.ts (CAM++ speaker embedding). Loaded lazily + native —
// container-only (never in the Worker bundle).
declare module 'sherpa-onnx-node';
