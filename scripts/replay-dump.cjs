#!/usr/bin/env node
/**
 * Replay WebSocket messages from a dump file
 *
 * Usage:
 *   node scripts/replay-dump.cjs <dump-file> <websocket-url>
 *
 * Example:
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"
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

if (!dumpFile || !wsUrl) {
    console.error('Usage: node replay-dump.cjs <dump-file> <websocket-url>');
    console.error('Example: node replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"');
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
console.log('');

// Connect to WebSocket
console.log(`Connecting to: ${wsUrl}`);
const ws = new WebSocket(wsUrl);

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
        const remainingMs = Math.max(0, totalDurationMs - elapsedMs);
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
        const targetTime = replayStartTime + timeSinceStart;
        const delay = Math.max(0, targetTime - Date.now());

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
