#!/usr/bin/env node
/**
 * Replay WebSocket messages from a dump file
 *
 * Usage:
 *   node scripts/replay-dump.cjs <dump-file> <websocket-url> [speed] [-H "Name: Value"] ...
 *
 * Parameters:
 *   speed        - Playback speed multiplier (default: 1.0)
 *                  - speed=2 plays at 2x speed (half the delays)
 *                  - speed=0.5 plays at half speed (double the delays)
 *                  - speed=0 plays with no delay at all
 *   -H / --header - Add a custom HTTP header (can be repeated)
 *
 * Example:
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 2
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 0
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://..." -H "Authorization: Bearer token" -H "X-Tenant: foo"
 *   OPENAI_CUSTOM_API_KEY=sk-... node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://...&provider=openai_custom&openaiCustomUrl=wss://..."
 */

const fs = require('fs');
const WebSocket = require('ws');

// Helper function to format time as MM:SS or HH:MM:SS
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// Helper function to update status line
function updateStatusLine(current, total, remainingSec) {
    const percent = Math.floor((current / total) * 100);
    const bar = '='.repeat(Math.floor(percent / 2)) + ' '.repeat(50 - Math.floor(percent / 2));
    const status = `Progress: [${current}/${total}] |${bar}| ${percent}% | Remaining: ${formatTime(remainingSec)}`;
    process.stdout.write('\r' + status);
}

// Parse arguments
const dumpFile = process.argv[2];
const wsUrl = process.argv[3];

// Parse remaining args: optional speed (positional), -H/--header, --capture-translated
const extraArgs = process.argv.slice(4);
let speed = 1.0;
const extraHeaders = {};
let captureTranslatedPath = null;
// Hold the WebSocket open after the last replay message before closing, so the
// server has time to deliver any in-flight responses (e.g. tail-end translated
// audio from a simultaneous interpreter). Default 5 s — enough for gpt-realtime-translate
// to finish a typical ~30-word utterance.
let lingerMs = 5000;

for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === '-H' || arg === '--header') {
        const header = extraArgs[++i];
        if (!header) {
            console.error(`Error: ${arg} requires a value`);
            process.exit(1);
        }
        const colonIdx = header.indexOf(':');
        if (colonIdx === -1) {
            console.error(`Error: Invalid header format "${header}" — expected "Name: Value"`);
            process.exit(1);
        }
        const name = header.slice(0, colonIdx).trim();
        const value = header.slice(colonIdx + 1).trim();
        extraHeaders[name] = value;
    } else if (arg === '--capture-translated') {
        captureTranslatedPath = extraArgs[++i];
        if (!captureTranslatedPath) {
            console.error(`Error: --capture-translated requires a WAV output path`);
            process.exit(1);
        }
    } else if (arg === '--linger-ms') {
        lingerMs = parseInt(extraArgs[++i], 10);
        if (!Number.isFinite(lingerMs) || lingerMs < 0) {
            console.error(`Error: --linger-ms must be a non-negative integer`);
            process.exit(1);
        }
    } else if (!isNaN(parseFloat(arg)) && i === 0) {
        speed = parseFloat(arg);
    } else {
        console.error(`Error: Unknown argument "${arg}"`);
        process.exit(1);
    }
}

// Read openai_custom API key from environment variable
const openaiCustomApiKey = process.env.OPENAI_CUSTOM_API_KEY || null;

if (!dumpFile || !wsUrl) {
    console.error('Usage: node replay-dump.cjs <dump-file> <websocket-url> [speed] [-H "Name: Value"] ...');
    console.error('Example: node replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"');
    console.error('         node replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 2');
    console.error('         OPENAI_CUSTOM_API_KEY=sk-... node replay-dump.cjs /tmp/websocket-dump.jsonl "ws://...&provider=openai_custom&openaiCustomUrl=wss://..."');
    process.exit(1);
}

if (isNaN(speed) || speed < 0) {
    console.error('Error: Speed must be a non-negative number');
    process.exit(1);
}

// Check if file exists
if (!fs.existsSync(dumpFile)) {
    console.error(`Error: Dump file not found: ${dumpFile}`);
    process.exit(1);
}

// Read and parse dump file
console.log(`Reading dump file: ${dumpFile}`);
const lines = fs.readFileSync(dumpFile, 'utf8').split('\n').filter(line => line.trim());
const messages = lines.map(line => {
    try {
        return JSON.parse(line);
    } catch (error) {
        console.error('Failed to parse line:', line);
        return null;
    }
}).filter(msg => msg !== null);

// Calculate total duration
const firstTimestamp = messages[0]?.timestamp || 0;
const lastTimestamp = messages[messages.length - 1]?.timestamp || 0;
const totalDurationMs = lastTimestamp - firstTimestamp;
const totalDurationSec = Math.ceil(totalDurationMs / 1000);

console.log(`Loaded ${messages.length} messages`);
console.log(`Total duration: ${formatTime(totalDurationSec)}`);
console.log(`Playback speed: ${speed}x ${speed === 0 ? '(no delay)' : ''}`);
console.log('');

// Connect to WebSocket
console.log(`Connecting to: ${wsUrl}`);
const headers = { ...extraHeaders };
if (openaiCustomApiKey) headers['x-custom-openai-api-key'] = openaiCustomApiKey;
if (Object.keys(headers).length > 0) {
    console.log('Custom headers:', Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(', '));
}
const wsOptions = Object.keys(headers).length > 0 ? { headers } : {};
const ws = new WebSocket(wsUrl, wsOptions);

ws.on('open', () => {
    console.log('Connected! Starting replay...');
    console.log(''); // Blank line for transcripts to appear above status

    // Calculate timing for replay
    const replayStartTime = Date.now();

    let messageIndex = 0;
    let isComplete = false;

    // Periodic status update (every second)
    const statusInterval = setInterval(() => {
        if (isComplete) {
            clearInterval(statusInterval);
            return;
        }

        const elapsedMs = Date.now() - replayStartTime;
        // Adjust remaining time calculation based on speed
        const adjustedTotalDurationMs = speed === 0 ? 0 : totalDurationMs / speed;
        const remainingMs = Math.max(0, adjustedTotalDurationMs - elapsedMs);
        const remainingSec = Math.ceil(remainingMs / 1000);

        updateStatusLine(messageIndex, messages.length, remainingSec);
    }, 1000);

    function sendNextMessage() {
        if (messageIndex >= messages.length) {
            isComplete = true;
            clearInterval(statusInterval);
            process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
            console.log('\nReplay complete!');
            if (lingerMs > 0) {
                console.log(`Lingering ${lingerMs}ms for tail-end response audio…`);
                setTimeout(() => {
                    ws.close();
                }, lingerMs);
            } else {
                ws.close();
            }
            return;
        }

        const message = messages[messageIndex];
        const originalTimestamp = message.timestamp;
        const timeSinceStart = originalTimestamp - firstTimestamp;

        // Calculate delay based on speed
        let delay;
        if (speed === 0) {
            delay = 0; // No delay at all
        } else {
            const adjustedTimeSinceStart = timeSinceStart / speed;
            const targetTime = replayStartTime + adjustedTimeSinceStart;
            delay = Math.max(0, targetTime - Date.now());
        }

        setTimeout(() => {
            ws.send(message.data);
            messageIndex++;
            sendNextMessage();
        }, delay);
    }

    sendNextMessage();
});

// Lazy WASM decoder for --capture-translated. Initialised on the first
// translated audio event so plain replays don't pay the load cost.
// The /translate endpoint emits "event":"media" with opus payloads at 24 kHz mono.
let translatedCapture = null;

const CAPTURE_SAMPLE_RATE = 24000;

async function initTranslatedCapture(wavPath) {
    const OpusDecoderModule = require('../dist/opus-decoder.cjs');
    const path = require('path');
    const wasmBuffer = fs.readFileSync(path.join(__dirname, '../dist/opus-decoder.wasm'));
    const wasmModule = new WebAssembly.Module(wasmBuffer);

    const wasm = await new Promise((resolve, reject) => {
        OpusDecoderModule({
            instantiateWasm(info, receive) {
                try {
                    const instance = new WebAssembly.Instance(wasmModule, info);
                    receive(instance);
                    return instance.exports;
                } catch (e) {
                    reject(e);
                    throw e;
                }
            },
        }).then(m => resolve({
            decoder: m._opus_frame_decoder_create(CAPTURE_SAMPLE_RATE, 1),
            decode: m._opus_frame_decode,
            destroy: m._opus_frame_decoder_destroy,
            malloc: m._malloc,
            free: m._free,
            HEAP: m.wasmMemory.buffer,
        })).catch(reject);
    });

    if (wasm.decoder < 0) {
        throw new Error(`opus_decoder_create failed: ${wasm.decoder}`);
    }

    // 120 ms at the capture rate.
    const MAX_FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE * 120) / 1000;
    const inputPtr = wasm.malloc(4000);
    const outputPtr = wasm.malloc(MAX_FRAME_SAMPLES * 2);
    const inputView = new Uint8Array(wasm.HEAP, inputPtr, 4000);

    return {
        wavPath,
        pcmChunks: [],
        decodePacket(base64) {
            const bytes = Buffer.from(base64, 'base64');
            inputView.set(bytes);
            const samples = wasm.decode(wasm.decoder, inputPtr, bytes.length, outputPtr, MAX_FRAME_SAMPLES, 0);
            if (samples <= 0) return;
            // Copy out before the next call clobbers the heap region.
            const view = new Int16Array(wasm.HEAP, outputPtr, samples);
            this.pcmChunks.push(new Int16Array(view));
        },
        cleanup() {
            try { wasm.destroy(wasm.decoder); } catch (_) {}
            try { wasm.free(inputPtr); wasm.free(outputPtr); } catch (_) {}
        },
    };
}

function writeWavFile(filename, pcmChunks, sampleRate) {
    const totalSamples = pcmChunks.reduce((n, c) => n + c.length, 0);
    const dataSize = totalSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    let offset = 44;
    for (const chunk of pcmChunks) {
        for (let i = 0; i < chunk.length; i++) {
            buffer.writeInt16LE(chunk[i], offset);
            offset += 2;
        }
    }
    fs.writeFileSync(filename, buffer);
}

ws.on('message', (data) => {
    try {
        const parsed = JSON.parse(data.toString());

        // Check if this is a transcription result
        if (parsed.type === 'transcription-result' || parsed.event === 'transcription-result') {
            // Only show final transcripts (skip interim)
            if (!parsed.is_interim) {
                const text = parsed.transcript?.map(t => t.text).join(' ') || '';
                const participantId = parsed.participant?.id || 'unknown';
                const speakerPrefix = parsed.speaker !== undefined ? `[Speaker ${parsed.speaker}] ` : '';

                // Clear status line, print transcript, redraw status
                process.stdout.write('\r' + ' '.repeat(120) + '\r');
                console.log(`[${participantId}] ${speakerPrefix}${text}`);
            }
        }

        // Capture translated audio if requested. The /translate endpoint emits
        // "event":"media" for translated audio frames.
        const isTranslatedMedia = parsed.media?.payload && parsed.event === 'media';
        if (captureTranslatedPath && isTranslatedMedia) {
            if (!translatedCapture) {
                // Initialise on first frame. Drop frames that arrive before init completes.
                translatedCapture = { pending: [] };
                initTranslatedCapture(captureTranslatedPath).then(cap => {
                    const pending = translatedCapture.pending || [];
                    translatedCapture = cap;
                    for (const payload of pending) cap.decodePacket(payload);
                    process.stdout.write('\r' + ' '.repeat(120) + '\r');
                    console.log(`[capture] decoder ready; ${pending.length} buffered packet(s) drained`);
                }).catch(err => {
                    console.error('Failed to init translated capture:', err);
                });
                translatedCapture.pending.push(parsed.media.payload);
            } else if (translatedCapture.pending) {
                translatedCapture.pending.push(parsed.media.payload);
            } else {
                translatedCapture.decodePacket(parsed.media.payload);
            }
        }
    } catch (error) {
        // Not JSON or different format, ignore
    }
});

ws.on('error', (error) => {
    process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
    // Several WebSocket failure modes produce empty error.message (TCP RST,
    // upgrade abort). Dump the whole error so we can see what's actually wrong.
    const msg = error.message || `(empty) — full error: ${error.toString()} ${error.code ? `code=${error.code}` : ''}`;
    console.error('WebSocket error:', msg);
    if (error.stack) console.error(error.stack);
});

ws.on('close', () => {
    process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
    console.log('Connection closed');

    if (captureTranslatedPath && translatedCapture && translatedCapture.pcmChunks) {
        const totalSamples = translatedCapture.pcmChunks.reduce((n, c) => n + c.length, 0);
        if (totalSamples === 0) {
            console.log(`[capture] no translated audio received; not writing ${captureTranslatedPath}`);
        } else {
            writeWavFile(captureTranslatedPath, translatedCapture.pcmChunks, CAPTURE_SAMPLE_RATE);
            const durationSec = totalSamples / CAPTURE_SAMPLE_RATE;
            console.log(`[capture] wrote ${captureTranslatedPath} (${totalSamples} samples, ${durationSec.toFixed(2)}s)`);
        }
        translatedCapture.cleanup();
    } else if (captureTranslatedPath) {
        console.log(`[capture] decoder did not initialise; no WAV written`);
    }
});
