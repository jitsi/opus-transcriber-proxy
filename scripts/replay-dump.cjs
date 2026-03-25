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

// Parse remaining args: optional speed (positional) and -H/--header flags
const extraArgs = process.argv.slice(4);
let speed = 1.0;
const extraHeaders = {};

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
            ws.close();
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

ws.on('message', (data) => {
    try {
        const parsed = JSON.parse(data.toString());

        // Check if this is a transcription result
        if (parsed.type === 'transcription-result' || parsed.event === 'transcription-result') {
            // Only show final transcripts (skip interim)
            if (!parsed.is_interim) {
                const text = parsed.transcript?.map(t => t.text).join(' ') || '';
                const participantId = parsed.participant?.id || 'unknown';

                // Clear status line, print transcript, redraw status
                process.stdout.write('\r' + ' '.repeat(120) + '\r');
                console.log(`[${participantId}] ${text}`);
            }
        }
    } catch (error) {
        // Not JSON or different format, ignore
    }
});

ws.on('error', (error) => {
    process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
    console.error('WebSocket error:', error.message);
});

ws.on('close', () => {
    process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
    console.log('Connection closed');
});
