#!/usr/bin/env node
/**
 * Test client for streaming Opus audio to the transcription proxy.
 *
 * Usage:
 *   # First, convert any audio file to Ogg/Opus:
 *   ffmpeg -i input.mp3 -c:a libopus -b:a 24k -ar 48000 -ac 1 test.ogg
 *
 *   # Then stream it:
 *   node test/stream-test-client.js --url "wss://..." --file test.ogg --cf-token "xxx"
 *
 *   # To test reconnection:
 *   1. Run the script, let it stream some audio
 *   2. Press Ctrl+C to disconnect
 *   3. Run again with same sessionId to reconnect
 */

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        url: null,
        file: null,
        tag: 'test-participant-12345',
        cfClientId: process.env.CF_ACCESS_CLIENT_ID || null,
        cfClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || null,
        encoding: 'ogg-opus', // or 'opus' for raw frames
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
            case '--encoding':
            case '-e':
                options.encoding = args[++i];
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
Test client for streaming Opus audio to the transcription proxy.

Usage:
  node stream-test-client.js --url <websocket-url> --file <audio-file> [options]

Options:
  --url, -u        WebSocket URL (required)
  --file, -f       Audio file path (required)
  --tag, -t        Participant tag (default: test-participant-12345)
  --encoding, -e   Audio encoding: 'ogg-opus' or 'opus' (default: ogg-opus)
  --cf-id          Cloudflare Access Client ID (or set CF_ACCESS_CLIENT_ID env)
  --cf-secret      Cloudflare Access Client Secret (or set CF_ACCESS_CLIENT_SECRET env)
  --help, -h       Show this help

Examples:
  # Convert audio to Ogg/Opus first:
  ffmpeg -i input.mp3 -c:a libopus -b:a 24k -ar 48000 -ac 1 test.ogg

  # Stream to local container:
  node stream-test-client.js \\
    --url "ws://localhost:8080/transcribe?sessionId=test&sendBack=true&encoding=ogg-opus" \\
    --file test.ogg

  # Stream to staging with Cloudflare Access:
  node stream-test-client.js \\
    --url "wss://opus-transcriber.example.com/transcribe?sessionId=test&sendBack=true&encoding=ogg-opus" \\
    --file test.ogg \\
    --cf-id "xxx.access" \\
    --cf-secret "xxx"

Environment variables:
  CF_ACCESS_CLIENT_ID      Cloudflare Access Client ID
  CF_ACCESS_CLIENT_SECRET  Cloudflare Access Client Secret

Reconnection test:
  1. Run the script, let it stream some audio
  2. Press Ctrl+C to disconnect
  3. Wait a few seconds
  4. Run again with same sessionId to test session resumption
`);
}

const options = parseArgs();

if (!options.url || !options.file) {
    console.error('Error: --url and --file are required\n');
    printUsage();
    process.exit(1);
}

// Ensure encoding is in the URL
const url = new URL(options.url);
if (!url.searchParams.has('encoding')) {
    url.searchParams.set('encoding', options.encoding);
    options.url = url.toString();
    console.log(`Added encoding=${options.encoding} to URL`);
}

// Read the audio file
if (!fs.existsSync(options.file)) {
    console.error(`File not found: ${options.file}`);
    process.exit(1);
}

const audioData = fs.readFileSync(options.file);
console.log(`Loaded ${options.file}: ${audioData.length} bytes`);

// Check if it's an Ogg file (starts with "OggS")
const isOgg = audioData.slice(0, 4).toString() === 'OggS';
console.log(`File format: ${isOgg ? 'Ogg/Opus container' : 'Raw Opus frames'}`);

if (isOgg && options.encoding !== 'ogg-opus') {
    console.warn(`Warning: File appears to be Ogg but encoding is set to '${options.encoding}'`);
}

// Build WebSocket options with headers
const wsOptions = {
    headers: {}
};

// Add Cloudflare Access headers if provided
if (options.cfClientId && options.cfClientSecret) {
    wsOptions.headers['CF-Access-Client-Id'] = options.cfClientId;
    wsOptions.headers['CF-Access-Client-Secret'] = options.cfClientSecret;
    console.log('Using Cloudflare Access authentication');
}

// Connect to WebSocket
console.log(`Connecting to ${options.url}...`);
const ws = new WebSocket(options.url, wsOptions);

let chunkNo = 0;
let timestamp = 0;
let streamInterval = null;
let offset = 0;

// For Ogg container, we send larger chunks since it includes headers
// For raw Opus, each frame is typically 20ms = ~60 bytes at 24kbps
const CHUNK_SIZE = isOgg ? 200 : 60;
const CHUNK_INTERVAL_MS = 20; // 20ms per chunk (simulating real-time)

ws.on('open', () => {
    console.log('Connected! Starting audio stream...');
    console.log(`Tag: ${options.tag}`);
    console.log(`Encoding: ${options.encoding}`);
    console.log(`Chunk size: ${CHUNK_SIZE} bytes, interval: ${CHUNK_INTERVAL_MS}ms`);
    console.log('');
    console.log('Press Ctrl+C to disconnect (then run again with same sessionId to test reconnection)');
    console.log('');

    // Start streaming audio
    streamInterval = setInterval(() => {
        if (offset >= audioData.length) {
            console.log('\nAudio file finished, looping...\n');
            offset = 0;
            // Don't reset chunkNo/timestamp to simulate continuous stream
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

            // Log progress every 50 chunks (1 second)
            if (chunkNo % 50 === 0) {
                const progress = ((offset / audioData.length) * 100).toFixed(1);
                const seconds = (chunkNo * CHUNK_INTERVAL_MS / 1000).toFixed(1);
                console.log(`[${seconds}s] Sent chunk ${chunkNo}, progress ${progress}%`);
            }
        } catch (err) {
            console.error('Failed to send:', err.message);
        }

        offset = end;
        chunkNo++;
        timestamp += 960; // 20ms at 48kHz = 960 samples
    }, CHUNK_INTERVAL_MS);
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'transcription-result') {
            const text = msg.transcript?.map(t => t.text).join(' ') || '';
            const interim = msg.is_interim ? ' (interim)' : ' ✓';
            const participant = msg.participant?.id || 'unknown';
            console.log(`\n📝 [${participant}]${interim}: ${text}\n`);
        } else if (msg.event === 'pong') {
            // Ignore pong responses
        } else {
            console.log('Received:', JSON.stringify(msg).substring(0, 200));
        }
    } catch (e) {
        console.log('Received non-JSON:', data.toString().substring(0, 100));
    }
});

ws.on('close', (code, reason) => {
    console.log(`\nDisconnected: code=${code}, reason=${reason || 'none'}`);
    if (streamInterval) clearInterval(streamInterval);
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    if (streamInterval) clearInterval(streamInterval);
    process.exit(1);
});

// Send periodic pings to keep connection alive
const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'ping', id: Date.now() }));
    }
}, 5000);

// Handle Ctrl+C - exit immediately
process.on('SIGINT', () => {
    console.log('\n\nDisconnecting (Ctrl+C)...');
    if (streamInterval) clearInterval(streamInterval);
    if (pingInterval) clearInterval(pingInterval);

    // Try graceful close, but force exit after 500ms
    ws.close(1000, 'User requested disconnect');
    setTimeout(() => {
        console.log('Force exit');
        process.exit(0);
    }, 500);
});
