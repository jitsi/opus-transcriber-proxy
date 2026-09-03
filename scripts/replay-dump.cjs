#!/usr/bin/env node
/**
 * Replay WebSocket messages from a dump file
 *
 * Usage:
 *   node scripts/replay-dump.cjs <dump-file> <websocket-url> [speed] ...
 *
 * Parameters:
 *   speed        - Playback speed multiplier (default: 1.0)
 *                  - speed=2 plays at 2x speed (half the delays)
 *                  - speed=0.5 plays at half speed (double the delays)
 *                  - speed=0 plays with no delay at all
 *   REPLAY_HEADERS (env) - Extra request headers as a JSON object {"Name":"Value",...}. Passed via
 *                  the environment rather than a flag so header values (which may be credentials)
 *                  stay out of the process argument list.
 *   --translate[=<lang>] - For the /translate endpoint: on connect, send the control message that
 *                  enables a target language (`start-translation`), so every source is translated
 *                  into <lang> (default "es"). The endpoint returns translated `media` (Opus) plus
 *                  `realtime-translation-result` transcripts. Received media packets are counted.
 *   --text-translate=<lang>[,<lang>...] - For the /transcribe endpoint: on connect, request text
 *                  translation of the finals into these languages, the way the JVB does it (a
 *                  `sources` event whose `requests` list is the authoritative full set). The server
 *                  returns one `translation-result` per language per final; they are printed and
 *                  counted separately from transcripts.
 *   --save-audio[=<dir>] - Save the returned translated audio as one Ogg-Opus file per source tag
 *                  (`<dir>/<tag>.opus`, default dir "."). Playable in ffplay/VLC/browsers.
 *   --ci           - Assertion mode for scripted/CI use (no-op unless combined with the flags below):
 *                    treats a WebSocket-level error as failure, enforces --connect-timeout, and on
 *                    close checks any --assert-min-* thresholds, printing a final
 *                    "INTEGRATION_RESULT: PASS|FAIL" line and exiting 0/1 accordingly. Without --ci
 *                    the script behaves exactly as before (always exits 0, no assertions). A
 *                    WS-level error, an uncaught exception, or an unhandled rejection all print a
 *                    FAIL line with as much of the underlying error as Node exposes — .code/.errno/
 *                    .syscall/.address/.port and any wrapped .cause/.errors[] (needed because a
 *                    connect failure often surfaces as an AggregateError whose own .message is
 *                    empty, with the real "connect ECONNREFUSED host:port" detail only in .errors[]).
 *   --connect-timeout=<sec> - (--ci only) fail if the WebSocket doesn't open within this many
 *                  seconds (default 15).
 *   --drain=<sec>  - After the last frame is sent, keep the socket open up to this long for trailing
 *                  finals before closing (default 10). In --ci mode this is only an upper bound: the
 *                  socket closes as soon as every --assert-min-* threshold is met, so the full drain
 *                  elapses only when the expected transcripts never arrive.
 *   --assert-min-finals=<N>   - (--ci only) fail unless at least N final transcripts were received.
 *   --assert-min-interims=<N> - (--ci only) fail unless at least N interim transcripts were received.
 *   --assert-min-finals-or-interims=<N> - (--ci only) fail unless at least N final OR N interim
 *                  transcripts were received (either counts). Use this instead of
 *                  --assert-min-finals when a slow-to-finalize provider (or a fast/full-speed replay
 *                  that throws off silence-based finalization timing) should not fail the check as
 *                  long as the backend is visibly transcribing.
 *   --assert-min-media=<N>    - (--ci only) fail unless at least N translated media packets were received.
 *   --assert-min-text-translations=<N> - (--ci only) fail unless at least N text translations
 *                  (`translation-result`) were received. Use it with --text-translate.
 *
 * Example:
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 2
 *   node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 0
 *   REPLAY_HEADERS='{"Authorization":"Bearer token","X-Tenant":"foo"}' node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://..."
 *   node scripts/replay-dump.cjs resources/sample.jsonl "wss://host/translate?sendBack=true" 1 --translate=es
 *   OPENAI_CUSTOM_API_KEY=sk-... node scripts/replay-dump.cjs /tmp/websocket-dump.jsonl "ws://...&provider=openai_custom&openaiCustomUrl=wss://..."
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Counters for messages received back from the server.
let mediaPacketsReceived = 0; // translated `media` (Opus) frames — the /translate audio return path
let finalTranscripts = 0;
let interimTranscripts = 0;
// Translated transcript text (inner type `translation-result`) — the /transcribe text-translation
// return path. Counted separately from transcripts: it is a translation OF a final, not a final.
let textTranslations = 0;
// Talk-boundary events bracketing translated audio. Only start/stop that carry a `timestamp` are the
// per-talk sending-change boundaries (a plain start/stop without one is a stream announcement).
let talkStartEvents = 0;
let talkStopEvents = 0;
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
    const status = `Progress: [${current}/${total}] |${bar}| ${percent}% | Remaining: ${formatTime(remainingSec)} | media rx: ${mediaPacketsReceived} | interim: ${interimTranscripts} | finals: ${finalTranscripts}`;
    process.stdout.write('\r' + status);
}

// Parse arguments
const dumpFile = process.argv[2];
const wsUrl = process.argv[3];

// Parse remaining args: optional speed (positional) and the -- flags
const extraArgs = process.argv.slice(4);
let speed = 1.0;
const extraHeaders = {};
let translateLang = null; // when set, send `start-translation` signaling for this target language
let textTranslateLangs = null; // when set, send a `sources` event requesting these text-translation languages
let saveAudioDir = null;  // when set, save returned translated audio as per-tag .opus files here
let ciMode = false;
let connectTimeoutSec = 15;
let drainSec = 10; // seconds to keep the socket open after the last frame for trailing finals (the cap)
let assertMinFinals = null;
let assertMinInterims = null;
let assertMinFinalsOrInterims = null;
let assertMinMedia = null;
let assertMinTextTranslations = null;

for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === '--translate' || arg.startsWith('--translate=')) {
        const eq = arg.indexOf('=');
        translateLang = eq !== -1 ? arg.slice(eq + 1).trim() : 'es';
        if (!translateLang) {
            console.error('Error: --translate=<lang> requires a language (e.g. --translate=es)');
            process.exit(1);
        }
    } else if (arg === '--text-translate' || arg.startsWith('--text-translate=')) {
        const eq = arg.indexOf('=');
        const raw = eq !== -1 ? arg.slice(eq + 1) : '';
        textTranslateLangs = raw.split(',').map((lang) => lang.trim()).filter((lang) => lang);
        if (textTranslateLangs.length === 0) {
            console.error('Error: --text-translate=<lang>[,<lang>...] requires at least one language (e.g. --text-translate=fr,de)');
            process.exit(1);
        }
    } else if (arg === '--save-audio' || arg.startsWith('--save-audio=')) {
        const eq = arg.indexOf('=');
        saveAudioDir = eq !== -1 ? arg.slice(eq + 1).trim() : '.';
    } else if (arg === '--ci') {
        ciMode = true;
    } else if (arg.startsWith('--connect-timeout=')) {
        connectTimeoutSec = parseFloat(arg.slice('--connect-timeout='.length));
    } else if (arg.startsWith('--drain=')) {
        drainSec = parseFloat(arg.slice('--drain='.length));
    } else if (arg.startsWith('--assert-min-finals=')) {
        assertMinFinals = parseInt(arg.slice('--assert-min-finals='.length), 10);
    } else if (arg.startsWith('--assert-min-interims=')) {
        assertMinInterims = parseInt(arg.slice('--assert-min-interims='.length), 10);
    } else if (arg.startsWith('--assert-min-finals-or-interims=')) {
        assertMinFinalsOrInterims = parseInt(arg.slice('--assert-min-finals-or-interims='.length), 10);
    } else if (arg.startsWith('--assert-min-media=')) {
        assertMinMedia = parseInt(arg.slice('--assert-min-media='.length), 10);
    } else if (arg.startsWith('--assert-min-text-translations=')) {
        assertMinTextTranslations = parseInt(arg.slice('--assert-min-text-translations='.length), 10);
    } else if (!isNaN(parseFloat(arg)) && i === 0) {
        speed = parseFloat(arg);
    } else {
        console.error(`Error: Unknown argument "${arg}"`);
        process.exit(1);
    }
}

// Extra request headers come from the REPLAY_HEADERS env var (a JSON object of "Name": "Value").
// Using an env var rather than CLI flags keeps header values — which may be credentials — out of
// the process argument list (e.g. `ps`).
const rawHeaders = process.env.REPLAY_HEADERS;
if (rawHeaders) {
    let parsedHeaders;
    try {
        parsedHeaders = JSON.parse(rawHeaders);
    } catch {
        console.error('Error: REPLAY_HEADERS must be valid JSON (an object of "Name": "Value")');
        process.exit(1);
    }
    if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) {
        console.error('Error: REPLAY_HEADERS must be a JSON object of "Name": "Value"');
        process.exit(1);
    }
    for (const [name, value] of Object.entries(parsedHeaders)) {
        extraHeaders[name] = String(value);
    }
}

// Read openai_custom API key from environment variable
const openaiCustomApiKey = process.env.OPENAI_CUSTOM_API_KEY || null;

if (!dumpFile || !wsUrl) {
    console.error('Usage: node replay-dump.cjs <dump-file> <websocket-url> [speed] ...');
    console.error('Example: node replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true"');
    console.error('         node replay-dump.cjs /tmp/websocket-dump.jsonl "ws://localhost:8080/transcribe?transcribe=true&sendBack=true" 2');
    console.error('         REPLAY_HEADERS=\'{"CF-Access-Client-Id":"...","CF-Access-Client-Secret":"..."}\' node replay-dump.cjs dump.jsonl "wss://.../transcribe?..."');
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
    // Log header names only — values may be credentials.
    console.log('Custom headers:', Object.keys(headers).join(', '));
}
const wsOptions = Object.keys(headers).length > 0 ? { headers } : {};
const ws = new WebSocket(wsUrl, wsOptions);

let connected = false;
let connectTimeoutHandle = null;

// Early-success close (--ci): once every set --assert-min-* threshold is met there is nothing left
// to prove, so close immediately and let the 'close' handler report PASS — instead of holding the
// socket open for the full drain window. This removes the timing race where a trailing final arrives
// just after a fixed-length drain closes the socket (the monitor's main false-negative source).
// Gated on replayComplete so we never close mid-blast (a pending ws.send() on a closing socket would
// throw and trip the 'error' handler's hard FAIL).
let drainTimer = null;
let replayComplete = false;
let earlyClosed = false;
const hasCiAsserts = assertMinFinals !== null || assertMinInterims !== null || assertMinFinalsOrInterims !== null || assertMinMedia !== null || assertMinTextTranslations !== null;
function ciAssertsSatisfied() {
    if (assertMinFinals !== null && finalTranscripts < assertMinFinals) return false;
    if (assertMinInterims !== null && interimTranscripts < assertMinInterims) return false;
    if (assertMinFinalsOrInterims !== null && finalTranscripts < assertMinFinalsOrInterims && interimTranscripts < assertMinFinalsOrInterims) return false;
    if (assertMinMedia !== null && mediaPacketsReceived < assertMinMedia) return false;
    if (assertMinTextTranslations !== null && textTranslations < assertMinTextTranslations) return false;
    return true;
}
function finishEarly() {
    if (earlyClosed || !ciMode || !hasCiAsserts || !replayComplete) return;
    if (!ciAssertsSatisfied()) return;
    earlyClosed = true;
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    process.stdout.write('\r' + ' '.repeat(120) + '\r');
    console.log(`\nAssertions satisfied (${finalTranscripts} final(s)) — closing early instead of draining.`);
    ws.close();
}

if (ciMode) {
    connectTimeoutHandle = setTimeout(() => {
        if (!connected) {
            console.error(`INTEGRATION_RESULT: FAIL: did not connect within ${connectTimeoutSec}s`);
            process.exit(1);
        }
    }, connectTimeoutSec * 1000);
}

ws.on('open', () => {
    connected = true;
    if (connectTimeoutHandle) clearTimeout(connectTimeoutHandle);
    console.log('Connected! Starting replay...');

    // For /translate: enable a target language before sending media. `start-translation` applies the
    // language to every source (the dev/replay path); the JVB uses `sources` events instead.
    if (translateLang) {
        const signaling = { event: 'start-translation', translation: { language: translateLang } };
        ws.send(JSON.stringify(signaling));
        console.log(`Enabled translation → ${translateLang}: ${JSON.stringify(signaling)}`);
    }

    // For /transcribe text translation: request the target languages the way the JVB does, in a
    // `sources` event. `requests` is the authoritative full set.
    if (textTranslateLangs) {
        const signaling = { event: 'sources', exports: [], requests: textTranslateLangs };
        ws.send(JSON.stringify(signaling));
        console.log(`Requested text translation → ${textTranslateLangs.join(', ')}: ${JSON.stringify(signaling)}`);
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
            replayComplete = true;
            clearInterval(statusInterval);
            process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
            console.log(`\nReplay complete! Draining trailing transcripts (up to ${drainSec}s)...`);
            // Keep the socket open so trailing finals (emitted after the force-commit timeout once
            // audio stops) are received before closing. This is now the upper bound: in --ci mode
            // finishEarly() closes as soon as the asserts are met, so the full drain only elapses
            // when the expected transcripts never arrive (a genuine failure).
            drainTimer = setTimeout(() => ws.close(), drainSec * 1000);
            finishEarly(); // asserts may already be satisfied by the time the blast finishes
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
            finishEarly();
            return;
        }

        // Talk-boundary start/stop events bracketing translated audio: print each with its RTP timestamp
        // so voice start vs stop is visible. Only the timestamped ones are per-talk sending-change
        // boundaries (a plain start/stop without a timestamp is a stream announcement).
        if (parsed.event === 'start' || parsed.event === 'stop') {
            const ts = parsed[parsed.event]?.timestamp;
            const tag = parsed[parsed.event]?.tag;
            if (ts != null) { if (parsed.event === 'start') talkStartEvents++; else talkStopEvents++; }
            process.stdout.write('\r' + ' '.repeat(120) + '\r');
            console.log(`<talk ${parsed.event}> tag=${tag} timestamp=${ts ?? '(none)'}`);
            return;
        }

        // Text translation of a final (`event: transcription-result`, inner `type:
        // translation-result`). Its text is a plain string, not a `transcript[]` array, so it is
        // handled before the transcript branch below — which would otherwise print it empty and
        // count it as a final.
        if (parsed.type === 'translation-result') {
            textTranslations++;
            process.stdout.write('\r' + ' '.repeat(120) + '\r');
            console.log(`<translation ${parsed.language}> [${parsed.participant?.id || 'unknown'}] ${parsed.text || ''}`);
            finishEarly();
            return;
        }

        // Check if this is a transcription result (transcription-result or realtime-translation-result)
        if (parsed.type === 'transcription-result' || parsed.type === 'realtime-translation-result' || parsed.event === 'transcription-result') {
            const text = parsed.transcript?.map(t => t.text).join(' ') || '';
            const participantId = parsed.participant?.id || 'unknown';
            const speakerPrefix = parsed.speaker !== undefined ? `[Speaker ${parsed.speaker}] ` : '';
            const lang = parsed.language ? ` (${parsed.language})` : '';
            const marker = parsed.is_interim ? ' [interim]' : '';
            if (parsed.is_interim) interimTranscripts++; else finalTranscripts++;

            // Clear status line, print transcript, redraw status
            process.stdout.write('\r' + ' '.repeat(120) + '\r');
            console.log(`[${participantId}]${lang}${marker} ${speakerPrefix}${text}`);

            finishEarly();
        }
    } catch (error) {
        // Not JSON or different format, ignore
    }
});

// error.message is sometimes empty (seen for a WS-level error with no application-layer response —
// e.g. the request never reaching the server at all). Node's underlying system errors (DNS/TCP/TLS
// failures) carry the real detail in .code/.errno/.syscall/.address/.port instead, and .cause chains
// through a wrapped error — pull all of it in so a bare error still says something useful.
function describeError(err) {
    if (!err || typeof err !== 'object') return String(err);
    const parts = [];
    parts.push(err.name && err.name !== 'Error' ? `${err.name}: ${err.message || '(no message)'}` : (err.message || '(no message)'));
    for (const field of ['code', 'errno', 'syscall', 'address', 'port']) {
        if (err[field] !== undefined) parts.push(`${field}=${err[field]}`);
    }
    if (err.cause) parts.push(`cause=(${describeError(err.cause)})`);
    // Node's connect path (dual-stack IPv4/IPv6) reports failure as an AggregateError whose own
    // .message is empty — the actual per-address reason (e.g. "connect ECONNREFUSED 127.0.0.1:PORT")
    // is only in .errors[]. Without this, an AggregateError prints as just "code=..." with no
    // indication of what host/port was actually being connected to.
    if (Array.isArray(err.errors) && err.errors.length > 0) {
        parts.push(`errors=[${err.errors.map(describeError).join('; ')}]`);
    }
    return parts.join(' ');
}

ws.on('error', (error) => {
    process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
    console.error('WebSocket error:', describeError(error));
    if (ciMode) {
        // process.exit() here is synchronous and load-bearing: it's what makes a WS-level error a
        // hard FAIL. The 'close' handler's --assert-min-* checks below have no way to distinguish
        // "0 transcripts because nothing arrived" from "0 transcripts because we errored out before
        // anything could arrive" — without this exit, a connection error with assertions unset
        // would fall through to 'close' and print a false PASS.
        console.error(`INTEGRATION_RESULT: FAIL: WebSocket error: ${describeError(error)}`);
        process.exit(1);
    }
});

if (ciMode) {
    // Safety net: without this, a crash before any INTEGRATION_RESULT line (e.g. an unhandled promise
    // rejection somewhere in the ws internals) surfaces to the monitor as the opaque "replay exited N
    // with no result line" — no detail on what actually happened. Print what we can before exiting.
    process.on('uncaughtException', (err) => {
        console.error(`INTEGRATION_RESULT: FAIL: uncaught exception: ${describeError(err)}`);
        process.exit(1);
    });
    process.on('unhandledRejection', (err) => {
        console.error(`INTEGRATION_RESULT: FAIL: unhandled rejection: ${describeError(err)}`);
        process.exit(1);
    });
}

ws.on('close', () => {
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear status line
    console.log(`Connection closed. Received ${mediaPacketsReceived} media packet(s), ${interimTranscripts} interim + ${finalTranscripts} final transcript(s), ${textTranslations} text translation(s), ${talkStartEvents} talk-start + ${talkStopEvents} talk-stop event(s).`);

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

    if (ciMode) {
        const failures = [];
        if (assertMinFinals !== null && finalTranscripts < assertMinFinals) {
            failures.push(`expected >= ${assertMinFinals} final transcript(s), got ${finalTranscripts}`);
        }
        if (assertMinInterims !== null && interimTranscripts < assertMinInterims) {
            failures.push(`expected >= ${assertMinInterims} interim transcript(s), got ${interimTranscripts}`);
        }
        if (assertMinFinalsOrInterims !== null && finalTranscripts < assertMinFinalsOrInterims && interimTranscripts < assertMinFinalsOrInterims) {
            failures.push(`expected >= ${assertMinFinalsOrInterims} final or interim transcript(s), got ${finalTranscripts} final(s) and ${interimTranscripts} interim(s)`);
        }
        if (assertMinMedia !== null && mediaPacketsReceived < assertMinMedia) {
            failures.push(`expected >= ${assertMinMedia} media packet(s), got ${mediaPacketsReceived}`);
        }
        if (assertMinTextTranslations !== null && textTranslations < assertMinTextTranslations) {
            failures.push(`expected >= ${assertMinTextTranslations} text translation(s), got ${textTranslations}`);
        }
        if (failures.length > 0) {
            console.error(`INTEGRATION_RESULT: FAIL: ${failures.join('; ')}`);
            process.exit(1);
        }
        console.log('INTEGRATION_RESULT: PASS');
        process.exit(0);
    }
});
