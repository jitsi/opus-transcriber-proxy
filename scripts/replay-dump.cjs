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

console.log(`Loaded ${messages.length} messages`);

// Connect to WebSocket
console.log(`Connecting to: ${wsUrl}`);
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
    console.log('Connected! Starting replay...');

    // Calculate timing for replay
    const firstTimestamp = messages[0]?.timestamp || Date.now();
    const replayStartTime = Date.now();

    let messageIndex = 0;

    function sendNextMessage() {
        if (messageIndex >= messages.length) {
            console.log('Replay complete!');
            ws.close();
            return;
        }

        const message = messages[messageIndex];
        const originalTimestamp = message.timestamp;
        const timeSinceStart = originalTimestamp - firstTimestamp;
        const targetTime = replayStartTime + timeSinceStart;
        const delay = Math.max(0, targetTime - Date.now());

        setTimeout(() => {
            console.log(`[${messageIndex + 1}/${messages.length}] Sending message (delay: ${delay}ms)`);
            ws.send(message.data);
            messageIndex++;
            sendNextMessage();
        }, delay);
    }

    sendNextMessage();
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
});

ws.on('close', () => {
    console.log('Connection closed');
});
