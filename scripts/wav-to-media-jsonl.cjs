#!/usr/bin/env node
/**
 * Synthesise a media.jsonl dump from any ffmpeg-readable audio file.
 *
 * Lets us drive the /translate endpoint (or the legacy /transcribe one) from
 * local TTS / phone-recorded audio without needing a JVB or a real recorded
 * conference dump.
 *
 * Strategy: convert the input to 24 kHz mono signed-16-bit-LE PCM via ffmpeg,
 * slice into 20 ms frames (960 bytes), optionally opus-encode each frame via
 * the WASM encoder, and emit one media event per frame in the JSONL envelope
 * the proxy writes when DUMP_WEBSOCKET_MESSAGES=true. The replay script reads
 * this back and sends it to the proxy at the original pacing.
 *
 * Default encoding is opus at 64 kbps mono VoIP — what /translate expects.
 * Pass --encoding l16 to emit raw PCM media events instead.
 *
 * Usage:
 *   node scripts/wav-to-media-jsonl.cjs <input> <output.jsonl> \
 *     [--tag NAME] [--start-epoch MS] [--trailing-silence-ms N] \
 *     [--encoding opus|l16] [--bitrate BPS]
 *
 *   <input> can be any format ffmpeg understands (.wav, .mp3, .m4a, .opus,
 *   .flac, .aac, .ogg, …).
 *
 *   --tag NAME             Participant tag (default: spike-<random>).
 *   --start-epoch MS       Outer-envelope ms-since-epoch of the first event
 *                          (default: Date.now()). Replay script paces sends
 *                          based on gaps between these values.
 *   --trailing-silence-ms  Pad the end of input with this many ms of zero-PCM
 *                          so server VAD has a clean end-of-speech (default
 *                          1500).
 *   --encoding             "opus" (default) or "l16". opus requires the WASM
 *                          encoder built via `npm run build:wasm`.
 *   --bitrate              Opus encoder bitrate, bps (default 64000).
 *
 * Example:
 *   # Generate a Spanish TTS clip and send it through /translate.
 *   say -v Paulina -o /tmp/es.aiff "Hola, estoy probando la traducción."
 *   node scripts/wav-to-media-jsonl.cjs /tmp/es.aiff /tmp/spike-es.jsonl --tag spike-es
 *   node scripts/replay-dump.cjs /tmp/spike-es.jsonl \
 *     "ws://localhost:8080/translate?lang=english&voice=alloy&sendBack=true" \
 *     --capture-translated /tmp/spike-es-translated.wav
 */

const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const SAMPLE_RATE_HZ = 24000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE_HZ * FRAME_DURATION_MS) / 1000; // 480
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS * BYTES_PER_SAMPLE; // 960

// libopus constants (from opus_defines.h).
const OPUS_APPLICATION_VOIP = 2048;
const MAX_OPUS_PACKET_BYTES = 4000;

function parseArgs(argv) {
	const positional = [];
	const opts = {
		tag: null,
		startEpoch: null,
		trailingSilenceMs: 1500,
		encoding: 'opus',
		bitrate: 64000,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--tag') {
			opts.tag = argv[++i];
		} else if (a === '--start-epoch') {
			opts.startEpoch = parseInt(argv[++i], 10);
		} else if (a === '--trailing-silence-ms') {
			opts.trailingSilenceMs = parseInt(argv[++i], 10);
		} else if (a === '--encoding') {
			opts.encoding = argv[++i];
		} else if (a === '--bitrate') {
			opts.bitrate = parseInt(argv[++i], 10);
		} else if (a === '-h' || a === '--help') {
			printUsageAndExit(0);
		} else if (a.startsWith('-')) {
			console.error(`Unknown flag: ${a}`);
			printUsageAndExit(2);
		} else {
			positional.push(a);
		}
	}
	if (positional.length !== 2) {
		printUsageAndExit(2);
	}
	if (!Number.isFinite(opts.trailingSilenceMs) || opts.trailingSilenceMs < 0) {
		console.error('--trailing-silence-ms must be a non-negative integer');
		printUsageAndExit(2);
	}
	if (opts.encoding !== 'opus' && opts.encoding !== 'l16') {
		console.error(`--encoding must be "opus" or "l16", got "${opts.encoding}"`);
		printUsageAndExit(2);
	}
	if (!Number.isFinite(opts.bitrate) || opts.bitrate <= 0) {
		console.error('--bitrate must be a positive integer');
		printUsageAndExit(2);
	}
	return {
		input: positional[0],
		output: positional[1],
		tag: opts.tag || `spike-${Math.random().toString(36).slice(2, 10)}`,
		startEpoch: Number.isFinite(opts.startEpoch) ? opts.startEpoch : Date.now(),
		trailingSilenceMs: opts.trailingSilenceMs,
		encoding: opts.encoding,
		bitrate: opts.bitrate,
	};
}

function printUsageAndExit(code) {
	console.error('Usage: node scripts/wav-to-media-jsonl.cjs <input> <output.jsonl> \\');
	console.error('         [--tag NAME] [--start-epoch MS] [--trailing-silence-ms N] \\');
	console.error('         [--encoding opus|l16] [--bitrate BPS]');
	console.error('');
	console.error('--encoding opus (default): opus-encode each 20 ms PCM frame for /translate.');
	console.error('--encoding l16: emit raw PCM media events (no encoding).');
	console.error('--bitrate (default 64000): opus encoder bitrate in bps. Ignored for l16.');
	console.error('--trailing-silence-ms (default 1500): pad input end with zero-PCM so server');
	console.error('  VAD has a clear end-of-speech to detect before the replay disconnects.');
	process.exit(code);
}

function checkFfmpeg() {
	const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
	if (r.status !== 0) {
		console.error('ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`) and retry.');
		process.exit(1);
	}
}

function decodeToPcm(inputPath) {
	const r = spawnSync(
		'ffmpeg',
		[
			'-loglevel', 'error',
			'-i', inputPath,
			'-ac', String(CHANNELS),
			'-ar', String(SAMPLE_RATE_HZ),
			'-f', 's16le',
			'-',
		],
		{ maxBuffer: 1024 * 1024 * 1024 },
	);
	if (r.status !== 0) {
		console.error('ffmpeg failed:');
		console.error(r.stderr.toString());
		process.exit(1);
	}
	return r.stdout;
}

function padWithSilence(pcm, trailingSilenceMs) {
	if (trailingSilenceMs <= 0) {
		return pcm;
	}
	const silenceBytes = Math.round((trailingSilenceMs / 1000) * SAMPLE_RATE_HZ) * CHANNELS * BYTES_PER_SAMPLE;
	return Buffer.concat([pcm, Buffer.alloc(silenceBytes)]);
}

/**
 * Load the WASM opus encoder (src/OpusEncoder/) and return a thin handle.
 * Uses CommonJS require() against the same opus-encoder.cjs the TS wrapper
 * uses, but avoids the TS module graph so this script stays plain Node CJS.
 */
async function createOpusEncoder({ sampleRate, channels, bitrate }) {
	const cjsPath = path.join(__dirname, '../dist/opus-encoder.cjs');
	const wasmPath = path.join(__dirname, '../dist/opus-encoder.wasm');
	if (!fs.existsSync(cjsPath) || !fs.existsSync(wasmPath)) {
		console.error('opus-encoder WASM artefacts not found. Run `npm run build:wasm` first.');
		process.exit(1);
	}

	// eslint-disable-next-line global-require
	const OpusEncoderModule = require(cjsPath);
	const wasmBuffer = fs.readFileSync(wasmPath);
	const wasmModule = new WebAssembly.Module(wasmBuffer);

	const m = await OpusEncoderModule({
		instantiateWasm(info, receive) {
			const instance = new WebAssembly.Instance(wasmModule, info);
			receive(instance);
			return instance.exports;
		},
	});

	const ctx = m._opus_frame_encoder_create(sampleRate, channels, OPUS_APPLICATION_VOIP);
	if (ctx === 0) {
		throw new Error('opus_frame_encoder_create returned NULL');
	}
	m._opus_frame_encoder_set_bitrate(ctx, bitrate);

	const frameSizeSamples = m._opus_frame_encoder_get_frame_size(ctx);
	const frameBytes = frameSizeSamples * channels * BYTES_PER_SAMPLE;
	if (frameBytes !== BYTES_PER_FRAME) {
		console.error(`Unexpected encoder frame size: ${frameBytes} bytes (expected ${BYTES_PER_FRAME})`);
		process.exit(1);
	}

	const pcmPtr = m._malloc(frameBytes);
	const outPtr = m._malloc(MAX_OPUS_PACKET_BYTES);

	return {
		encode(pcmFrame) {
			m.HEAPU8.set(pcmFrame, pcmPtr);
			const bytes = m._opus_frame_encode(ctx, pcmPtr, frameBytes, outPtr, MAX_OPUS_PACKET_BYTES);
			if (bytes <= 0) {
				return null;
			}
			// Copy out before the next call reuses the heap region.
			return Buffer.from(m.HEAPU8.subarray(outPtr, outPtr + bytes));
		},
		free() {
			m._free(pcmPtr);
			m._free(outPtr);
			m._opus_frame_encoder_destroy(ctx);
		},
	};
}

function writeJsonl(outputPath, pcm, tag, startEpoch, encoding, encoder) {
	const out = fs.createWriteStream(outputPath);

	const mediaFormat = encoding === 'opus'
		? { encoding: 'opus', sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS }
		: { encoding: 'l16', sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS };

	const startEvent = { event: 'start', start: { tag, mediaFormat } };
	out.write(
		JSON.stringify({
			timestamp: startEpoch,
			direction: 'incoming',
			data: JSON.stringify(startEvent),
		}) + '\n',
	);

	let frameCount = 0;
	let rtpTimestamp = 0; // RTP clock in sample units at the input sample rate.
	let opusBytesTotal = 0;
	for (let offset = 0; offset + BYTES_PER_FRAME <= pcm.length; offset += BYTES_PER_FRAME) {
		const pcmFrame = pcm.subarray(offset, offset + BYTES_PER_FRAME);
		let payload;
		if (encoder) {
			const opusBytes = encoder.encode(pcmFrame);
			if (!opusBytes) {
				// Encoder error — skip this frame, keep going.
				continue;
			}
			opusBytesTotal += opusBytes.length;
			payload = opusBytes.toString('base64');
		} else {
			payload = pcmFrame.toString('base64');
		}

		const mediaEvent = {
			event: 'media',
			media: {
				tag,
				chunk: frameCount,
				timestamp: rtpTimestamp,
				payload,
			},
		};
		out.write(
			JSON.stringify({
				timestamp: startEpoch + frameCount * FRAME_DURATION_MS + 1,
				direction: 'incoming',
				data: JSON.stringify(mediaEvent),
			}) + '\n',
		);
		frameCount++;
		rtpTimestamp += SAMPLES_PER_FRAME;
	}

	out.end();
	return {
		frameCount,
		durationSec: (frameCount * FRAME_DURATION_MS) / 1000,
		opusBytesTotal,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	checkFfmpeg();

	if (!fs.existsSync(args.input)) {
		console.error(`Input not found: ${args.input}`);
		process.exit(1);
	}

	const outDir = path.dirname(args.output);
	if (outDir && !fs.existsSync(outDir)) {
		fs.mkdirSync(outDir, { recursive: true });
	}

	console.log(`Decoding ${args.input} → 24 kHz mono s16le PCM`);
	const rawPcm = decodeToPcm(args.input);
	console.log(`Got ${rawPcm.length} bytes of PCM (${(rawPcm.length / (SAMPLE_RATE_HZ * BYTES_PER_SAMPLE)).toFixed(2)}s)`);

	const pcm = padWithSilence(rawPcm, args.trailingSilenceMs);
	if (args.trailingSilenceMs > 0) {
		console.log(`Padded with ${args.trailingSilenceMs}ms of trailing silence for VAD end-of-speech detection`);
	}

	let encoder = null;
	if (args.encoding === 'opus') {
		console.log(`Loading WASM opus encoder (${args.bitrate} bps mono VoIP)`);
		encoder = await createOpusEncoder({
			sampleRate: SAMPLE_RATE_HZ,
			channels: CHANNELS,
			bitrate: args.bitrate,
		});
	}

	console.log(`Writing ${args.encoding} media events to ${args.output} with tag="${args.tag}"`);
	const { frameCount, durationSec, opusBytesTotal } = writeJsonl(
		args.output,
		pcm,
		args.tag,
		args.startEpoch,
		args.encoding,
		encoder,
	);
	console.log(`Wrote ${frameCount} media events (${durationSec.toFixed(2)}s of audio)`);
	if (encoder) {
		const avgBytes = frameCount > 0 ? Math.round(opusBytesTotal / frameCount) : 0;
		console.log(`Opus average packet size: ${avgBytes} bytes (${opusBytesTotal} total)`);
		encoder.free();
	}

	const trailing = pcm.length % BYTES_PER_FRAME;
	if (trailing > 0) {
		console.log(`Dropped ${trailing} trailing bytes (< one 20ms frame); pad input if you need them.`);
	}

	console.log('\nNext:');
	console.log(`  node scripts/replay-dump.cjs ${args.output} \\`);
	console.log(`    "ws://localhost:8080/translate?lang=english&voice=alloy&sendBack=true" \\`);
	console.log(`    --capture-translated /tmp/${args.tag}-translated.wav`);
	console.log('  (Pick lang=english|french|spanish|mandarin — see src/translation-instructions.ts.)');
	console.log('  (sendBack=true is needed if you want the transcript text logged to your terminal.)');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
