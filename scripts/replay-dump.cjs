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
 *   --translate[=<lang>] - For the /translate endpoint: on connect, send the control message that
 *                  enables a target language (`start-translation`), so every source is translated
 *                  into <lang> (default "es"). The endpoint returns translated `media` (Opus) plus
 *                  `realtime-translation-result` transcripts. Received media packets are counted.
 *   --save-audio[=<dir>] - Save the returned translated audio as one Ogg-Opus file per source tag
 *                  (`<dir>/<tag>.opus`, default dir "."). Playable in ffplay/VLC/browsers.
 *
 * Example:
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 2
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 0
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://..." -H "Authorization: Bearer token" -H "X-Tenant: foo"
 *   node scripts/replay-dump.cjs resources/sample.jsonl "wss://host/translate?sendBack=true" 1 --translate=es
 *   OPENAI_CUSTOM_API_KEY=sk-... node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://...&provider=openai_custom&openaiCustomUrl=wss://..."
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Counters for messages received back from the server.
let mediaPacketsReceived = 0; // translated `media` (Opus) frames — the /translate audio return path
let finalTranscripts = 0;
// tag -> array of Opus packets (Buffers) received for that synthetic source (for --save-audio).
const audioByTag = new Map();

// ---- Minimal Ogg-Opus muxer (for --save-audio) --------------------------------------------------
// The /translate `media` payloads are already Opus packets (one 20ms/48kHz frame each, mono), so we
// only wrap them in an Ogg container — no decoding needed. Output plays in ffplay/VLC/browsers.

const OGG_CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = (i << 24) >>> 0;
        for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1)) >>> 0;
        t[i] = r >>> 0;
    }
    return t;
})();

function oggCrc(buf) {
    let crc = 0;
    for (let i = 0; i < buf.length; i++) crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
    return crc >>> 0;
}

// Build one Ogg page carrying a single packet (Opus packets are small, so 1 packet/page is fine).
function oggPage(serial, pageSeq, headerType, granule, packet) {
    const segTable = [];
    let len = packet.length;
    while (len >= 255) { segTable.push(255); len -= 255; }
    segTable.push(len); // final lacing value (0..254; a 0 here correctly marks an exact multiple of 255)
    const header = Buffer.alloc(27 + segTable.length);
    header.write('OggS', 0, 'ascii');
    header.writeUInt8(0, 4);              // stream structure version
    header.writeUInt8(headerType, 5);     // 0x02 = BOS, 0x04 = EOS
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(serial >>> 0, 14);
    header.writeUInt32LE(pageSeq >>> 0, 18);
    header.writeUInt32LE(0, 22);          // CRC (filled below)
    header.writeUInt8(segTable.length, 26);
    for (let i = 0; i < segTable.length; i++) header.writeUInt8(segTable[i], 27 + i);
    const page = Buffer.concat([header, packet]);
    page.writeUInt32LE(oggCrc(page), 22);
    return page;
}

function opusHeadPacket(channels, inputSampleRate) {
    const b = Buffer.alloc(19);
    b.write('OpusHead', 0, 'ascii');
    b.writeUInt8(1, 8);                   // version
    b.writeUInt8(channels, 9);
    b.writeUInt16LE(0, 10);               // pre-skip (0 — negligible priming, fine for verification)
    b.writeUInt32LE(inputSampleRate, 12); // original rate (informational; Opus decodes at 48kHz)
    b.writeInt16LE(0, 16);                // output gain
    b.writeUInt8(0, 18);                  // channel mapping family 0
    return b;
}

function opusTagsPacket() {
    const vendor = Buffer.from('opus-transcriber-proxy replay');
    const b = Buffer.alloc(8 + 4 + vendor.length + 4);
    b.write('OpusTags', 0, 'ascii');
    b.writeUInt32LE(vendor.length, 8);
    vendor.copy(b, 12);
    b.writeUInt32LE(0, 12 + vendor.length); // user comment count
    return b;
}

// Write mono 20ms Opus packets as a .opus (Ogg-Opus) file. Each packet = 960 samples at 48kHz.
function writeOggOpus(filePath, packets) {
    const serial = (Math.floor(Math.random() * 0xffffffff)) >>> 0;
    let seq = 0;
    const pages = [
        oggPage(serial, seq++, 0x02, 0, opusHeadPacket(1, 24000)),
        oggPage(serial, seq++, 0x00, 0, opusTagsPacket()),
    ];
    let granule = 0;
    for (let i = 0; i < packets.length; i++) {
        granule += 960;
        const eos = i === packets.length - 1 ? 0x04 : 0x00;
        pages.push(oggPage(serial, seq++, eos, granule, packets[i]));
    }
    fs.writeFileSync(filePath, Buffer.concat(pages));
    return granule; // total 48kHz samples
}
// -------------------------------------------------------------------------------------------------

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
    const status = `Progress: [${current}/${total}] |${bar}| ${percent}% | Remaining: ${formatTime(remainingSec)} | media rx: ${mediaPacketsReceived} | finals: ${finalTranscripts}`;
    process.stdout.write('\r' + status);
}

// Parse arguments
const dumpFile = process.argv[2];
const wsUrl = process.argv[3];

// Parse remaining args: optional speed (positional) and -H/--header flags
const extraArgs = process.argv.slice(4);
let speed = 1.0;
const extraHeaders = {};
let translateLang = null; // when set, send `start-translation` signaling for this target language
let saveAudioDir = null;  // when set, save returned translated audio as per-tag .opus files here

for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === '--translate' || arg.startsWith('--translate=')) {
        const eq = arg.indexOf('=');
        translateLang = eq !== -1 ? arg.slice(eq + 1).trim() : 'es';
        if (!translateLang) {
            console.error('Error: --translate=<lang> requires a language (e.g. --translate=es)');
            process.exit(1);
        }
    } else if (arg === '--save-audio' || arg.startsWith('--save-audio=')) {
        const eq = arg.indexOf('=');
        saveAudioDir = eq !== -1 ? arg.slice(eq + 1).trim() : '.';
    } else if (arg === '-H' || arg === '--header') {
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

    // For /translate: enable a target language before sending media. `start-translation` applies the
    // language to every source (the dev/replay path); the JVB uses `sources` events instead.
    if (translateLang) {
        const signaling = { event: 'start-translation', translation: { language: translateLang } };
        ws.send(JSON.stringify(signaling));
        console.log(`Enabled translation → ${translateLang}: ${JSON.stringify(signaling)}`);
    }

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
            console.log('\nReplay complete! Draining trailing transcripts...');
            // Keep the socket open briefly so trailing finals (emitted after the
            // force-commit timeout once audio stops) are received before closing.
            setTimeout(() => ws.close(), 5000);
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

        // Translated audio frames returned by /translate — count them (not printed individually).
        if (parsed.event === 'media') {
            mediaPacketsReceived++;
            const tag = parsed.media?.tag;
            const payload = parsed.media?.payload;
            if (saveAudioDir && typeof tag === 'string' && typeof payload === 'string') {
                let packets = audioByTag.get(tag);
                if (!packets) { packets = []; audioByTag.set(tag, packets); }
                packets.push(Buffer.from(payload, 'base64'));
            }
            return;
        }

        // Check if this is a transcription result
        if (parsed.type === 'transcription-result' || parsed.event === 'transcription-result') {
            // Only show final transcripts (skip interim)
            if (!parsed.is_interim) {
                finalTranscripts++;
                const text = parsed.transcript?.map(t => t.text).join(' ') || '';
                const participantId = parsed.participant?.id || 'unknown';
                const speakerPrefix = parsed.speaker !== undefined ? `[Speaker ${parsed.speaker}] ` : '';

                // Clear status line, print transcript, redraw status
                process.stdout.write('\r' + ' '.repeat(120) + '\r');
                console.log(`[${participantId}] ${speakerPrefix}${text}`);
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
    console.log(`Connection closed. Received ${mediaPacketsReceived} media packet(s), ${finalTranscripts} final transcript(s).`);

    if (saveAudioDir && audioByTag.size > 0) {
        fs.mkdirSync(saveAudioDir, { recursive: true });
        for (const [tag, packets] of audioByTag) {
            const safe = tag.replace(/[^A-Za-z0-9._-]/g, '_');
            const filePath = path.join(saveAudioDir, `${safe}.opus`);
            const samples = writeOggOpus(filePath, packets);
            console.log(`Saved ${filePath} — ${packets.length} packets, ${(samples / 48000).toFixed(1)}s`);
        }
    } else if (saveAudioDir) {
        console.log('No translated media received — nothing to save.');
    }
});
