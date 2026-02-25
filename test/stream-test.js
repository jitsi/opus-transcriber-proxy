#!/usr/bin/env node
/**
 * Health check client for the transcription proxy.
 * Streams audio and verifies transcriptions are received.
 *
 * Exit codes:
 *   0 - Success (received at least one transcription)
 *   1 - Failure (no transcriptions, connection error, or timeout)
 *
 * Output:
 *   JSON summary to stdout with transcriptions and metrics.
 */

import WebSocket from 'ws';
import fs from 'fs';
import crypto from 'crypto';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        url: null,
        file: null,
        tag: `health-check-${Date.now()}`,
        cfClientId: process.env.CF_ACCESS_CLIENT_ID || null,
        cfClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || null,
        loop: false,
        timeout: 10,
        verbose: false,
        interims: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--url':
            case '-u':
                options.url = args[++i];
                break;
            case '--file':
            case '-f':
                options.file = args[++i];
                break;
            case '--tag':
            case '-t':
                options.tag = args[++i];
                break;
            case '--cf-id':
                options.cfClientId = args[++i];
                break;
            case '--cf-secret':
                options.cfClientSecret = args[++i];
                break;
            case '--loop':
                options.loop = true;
                break;
            case '--timeout':
                options.timeout = parseInt(args[++i], 10);
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--interims':
                options.interims = true;
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
        }
    }

    return options;
}

function printUsage() {
    console.log(`
Health check client for the transcription proxy.

Usage:
  node stream-test.js --url <base-url> --file <audio-file> [options]

Options:
  --url, -u        Base WebSocket URL, e.g. wss://example.com/transcribe (required)
  --file, -f       Ogg/Opus audio file path (required)
  --tag, -t        Participant tag (default: health-check-<timestamp>)
  --cf-id          Cloudflare Access Client ID (or CF_ACCESS_CLIENT_ID env)
  --cf-secret      Cloudflare Access Client Secret (or CF_ACCESS_CLIENT_SECRET env)
  --loop           Loop audio file continuously (default: off)
  --timeout <sec>  Seconds to wait for transcriptions after streaming (default: 10)
  --verbose, -v    Enable progress logging to stderr (default: quiet)
  --interims       Include interim transcriptions in output (default: finals only)
  --help, -h       Show this help

Environment:
  CF_ACCESS_CLIENT_ID      Cloudflare Access Client ID
  CF_ACCESS_CLIENT_SECRET  Cloudflare Access Client Secret

Exit codes:
  0 - Success (received at least one final transcription)
  1 - Failure (no transcriptions, connection error, or timeout)

Examples:
  # Health check (quiet, JSON output only):
  node test/stream-test.js \\
    --url wss://opus-transcriber.example.com/transcribe \\
    --file test/test.ogg

  # Verbose testing:
  node test/stream-test.js \\
    --url ws://localhost:8080/transcribe \\
    --file test.ogg \\
    --verbose --loop
`);
}

const options = parseArgs();

if (!options.url || !options.file) {
    console.error('Error: --url and --file are required\n');
    printUsage();
    process.exit(1);
}

function log(...args) {
    if (options.verbose) {
        console.error(...args);
    }
}

// Build full WebSocket URL with query params
function buildWebSocketUrl(baseUrl) {
    const url = new URL(baseUrl);
    const sessionId = `health-${crypto.randomUUID()}`;

    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('encoding', 'ogg-opus');
    url.searchParams.set('sendBack', 'true');

    log(`Session ID: ${sessionId}`);
    return url.toString();
}

// Read audio file
if (!fs.existsSync(options.file)) {
    console.error(JSON.stringify({ success: false, error: `File not found: ${options.file}` }));
    process.exit(1);
}

const audioData = fs.readFileSync(options.file);
const isOgg = audioData.slice(0, 4).toString() === 'OggS';

if (!isOgg) {
    console.error(JSON.stringify({ success: false, error: 'File must be Ogg/Opus format (starts with OggS header)' }));
    process.exit(1);
}

log(`Loaded ${options.file}: ${audioData.length} bytes`);

// WebSocket options with Cloudflare Access headers
const wsOptions = { headers: {} };

if (options.cfClientId && options.cfClientSecret) {
    wsOptions.headers['CF-Access-Client-Id'] = options.cfClientId;
    wsOptions.headers['CF-Access-Client-Secret'] = options.cfClientSecret;
    log('Using Cloudflare Access authentication');
}

// State and metrics
const metrics = {
    startTime: Date.now(),
    connectTime: null,
    firstTranscriptionTime: null,
    endTime: null,
    chunksSent: 0,
    bytesSent: 0,
    interimCount: 0,
    finalCount: 0,
    errors: [],
};

const transcriptions = [];
let ws = null;
let chunkNo = 0;
let timestamp = 0;
let streamInterval = null;
let pingInterval = null;
let offset = 0;
let streamingComplete = false;
let waitTimeout = null;

const CHUNK_SIZE = 200; // Ogg container chunks
const CHUNK_INTERVAL_MS = 20;

function getEstimatedDurationSec() {
    const totalChunks = Math.ceil(audioData.length / CHUNK_SIZE);
    return (totalChunks * CHUNK_INTERVAL_MS) / 1000;
}

function cleanup() {
    if (streamInterval) clearInterval(streamInterval);
    if (pingInterval) clearInterval(pingInterval);
    if (waitTimeout) clearTimeout(waitTimeout);
}

function exit(success) {
    cleanup();
    metrics.endTime = Date.now();

    const summary = {
        success,
        transcriptions,
        metrics: {
            durationMs: metrics.endTime - metrics.startTime,
            connectLatencyMs: metrics.connectTime ? metrics.connectTime - metrics.startTime : null,
            firstTranscriptionLatencyMs: metrics.firstTranscriptionTime
                ? metrics.firstTranscriptionTime - metrics.connectTime
                : null,
            estimatedAudioDurationSec: getEstimatedDurationSec(),
            chunksSent: metrics.chunksSent,
            bytesSent: metrics.bytesSent,
            interimCount: metrics.interimCount,
            finalCount: metrics.finalCount,
            errors: metrics.errors,
        },
    };

    console.log(JSON.stringify(summary, null, 2));

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Test complete');
    }

    process.exit(success ? 0 : 1);
}

function startWaitTimeout() {
    if (streamingComplete) return;
    streamingComplete = true;

    log(`Streaming complete. Waiting ${options.timeout}s for transcriptions...`);

    waitTimeout = setTimeout(() => {
        const success = metrics.finalCount > 0;
        log(success
            ? `Success: Received ${metrics.finalCount} transcription(s)`
            : 'Failure: No transcriptions received within timeout'
        );
        exit(success);
    }, options.timeout * 1000);
}

// Connect
const fullUrl = buildWebSocketUrl(options.url);
log(`Connecting to ${fullUrl}...`);
ws = new WebSocket(fullUrl, wsOptions);

ws.on('open', () => {
    metrics.connectTime = Date.now();
    log('Connected, streaming audio...');

    ws.send(JSON.stringify({
        event: 'start',
        start: {
            tag: options.tag,
            mediaFormat: { encoding: 'ogg-opus' },
        },
    }));

    streamInterval = setInterval(() => {
        if (offset >= audioData.length) {
            if (options.loop) {
                log('Looping audio...');
                offset = 0;
            } else {
                clearInterval(streamInterval);
                streamInterval = null;
                startWaitTimeout();
                return;
            }
        }

        const end = Math.min(offset + CHUNK_SIZE, audioData.length);
        const chunk = audioData.slice(offset, end);

        const message = {
            event: 'media',
            media: {
                tag: options.tag,
                payload: chunk.toString('base64'),
                chunk: chunkNo,
                timestamp: timestamp
            }
        };

        try {
            ws.send(JSON.stringify(message));
            metrics.chunksSent++;
            metrics.bytesSent += chunk.length;

            if (chunkNo % 50 === 0) {
                const progress = ((offset / audioData.length) * 100).toFixed(1);
                const seconds = (chunkNo * CHUNK_INTERVAL_MS / 1000).toFixed(1);
                log(`[${seconds}s] chunk ${chunkNo}, ${progress}%`);
            }
        } catch (err) {
            log('Send error:', err.message);
            metrics.errors.push({ type: 'send', message: err.message, time: Date.now() });
        }

        offset = end;
        chunkNo++;
        timestamp += 960;
    }, CHUNK_INTERVAL_MS);

    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'ping', id: Date.now() }));
        }
    }, 5000);
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'transcription-result') {
            const text = msg.transcript?.map(t => t.text).join(' ') || '';
            const isInterim = msg.is_interim;

            if (isInterim) {
                metrics.interimCount++;
                if (options.interims) {
                    transcriptions.push({
                        text,
                        interim: true,
                        participant: msg.participant?.id || options.tag,
                        timestamp: msg.timestamp,
                        language: msg.language,
                    });
                }
                log(`(interim): ${text}`);
            } else {
                metrics.finalCount++;
                if (!metrics.firstTranscriptionTime) {
                    metrics.firstTranscriptionTime = Date.now();
                }
                transcriptions.push({
                    text,
                    interim: false,
                    participant: msg.participant?.id || options.tag,
                    timestamp: msg.timestamp,
                    language: msg.language,
                });
                log(`[final]: ${text}`);
            }
        } else if (msg.event !== 'pong') {
            log('Received:', JSON.stringify(msg).substring(0, 200));
        }
    } catch (e) {
        log('Parse error:', data.toString().substring(0, 100));
    }
});

ws.on('close', (code, reason) => {
    log(`WebSocket closed: code=${code}, reason=${reason || 'none'}`);

    if (!streamingComplete) {
        metrics.errors.push({ type: 'close', code, reason: reason?.toString(), time: Date.now() });
        exit(false);
    }
});

ws.on('error', (err) => {
    log('WebSocket error:', err.message);
    metrics.errors.push({ type: 'error', message: err.message, time: Date.now() });
    exit(false);
});

process.on('SIGINT', () => {
    log('Interrupted');
    exit(metrics.finalCount > 0);
});
