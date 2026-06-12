#!/usr/bin/env node

/**
 * Decode opus audio from media.jsonl and mix into a WAV file
 *
 * Usage: node scripts/mix-audio.mjs [input.jsonl] [output.wav]
 *
 * Reads media.jsonl containing base64-encoded opus packets,
 * decodes them, mixes multiple streams, and outputs a WAV file.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Load the native Opus addon (compiled by `npm run build:native`). The actual
// run is deferred to a microtask so the top-level consts below are initialized
// before main() executes.
let nativeOpus;
try {
	nativeOpus = require(path.join(__dirname, '../build/Release/opus_native.node'));
} catch (error) {
	console.error('Failed to load the native Opus addon:', error);
	console.error('\nBuild it first:');
	console.error('  npm run build:native');
	process.exit(1);
}

Promise.resolve().then(() => main(nativeOpus)).catch((error) => {
	console.error('mix-audio failed:', error);
	process.exit(1);
});

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const MS_PER_PACKET = 20;
const SAMPLES_PER_PACKET = (SAMPLE_RATE * MS_PER_PACKET) / 1000; // 480 samples at 24kHz

async function main(nativeOpus) {
	const inputFile = process.argv[2] || 'media.jsonl';
	const outputFile = process.argv[3] || 'output.wav';

	if (!fs.existsSync(inputFile)) {
		console.error(`File not found: ${inputFile}`);
		console.error('\nUsage: node scripts/mix-audio.mjs <input.jsonl> [output.wav]');
		process.exit(1);
	}

	console.log(`Reading from ${inputFile}...`);
	const lines = fs.readFileSync(inputFile, 'utf-8').split('\n').filter(line => line.trim());

	// Group media packets by tag
	const streams = new Map();

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);

			// Parse the data field (might be a string or already an object)
			const data = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;

			if (entry.direction === 'incoming' && data?.event === 'media' && data?.media) {
				const { tag, payload, chunk, timestamp } = data.media;

				if (!tag || !payload || timestamp === undefined) continue;

				// Get or create stream for this tag
				if (!streams.has(tag)) {
					streams.set(tag, {
						tag,
						packets: [],
						minTimestamp: timestamp,
						maxTimestamp: timestamp,
					});
				}

				const stream = streams.get(tag);
				stream.minTimestamp = Math.min(stream.minTimestamp, timestamp);
				stream.maxTimestamp = Math.max(stream.maxTimestamp, timestamp);

				// Store packet with timestamp and payload
				stream.packets.push({
					timestamp,
					chunk,
					payload,
				});
			}
		} catch (error) {
			// Skip invalid lines
			continue;
		}
	}

	if (streams.size === 0) {
		console.error('No media packets found in input file');
		process.exit(1);
	}

	console.log(`Found ${streams.size} audio stream(s)`);

	// Sort packets by timestamp within each stream
	for (const stream of streams.values()) {
		stream.packets.sort((a, b) => a.timestamp - b.timestamp);
	}

	// Create opus decoder using the native addon
	console.log('Initializing Opus decoder...');
	const decoder = createOpusDecoder(nativeOpus, SAMPLE_RATE, CHANNELS);

	// Decode all packets
	console.log('Decoding audio packets...');
	for (const [tag, stream] of streams) {
		console.log(`  Stream ${tag}: timestamps ${stream.minTimestamp} to ${stream.maxTimestamp} (${stream.packets.length} packets)`);

		const decodedPackets = [];

		for (const packet of stream.packets) {
			try {
				// Decode base64 to binary
				const opusData = Buffer.from(packet.payload, 'base64');

				// Decode opus frame
				const pcmData = decodeOpusFrame(decoder, opusData);

				if (pcmData && pcmData.length > 0) {
					decodedPackets.push({
						timestamp: packet.timestamp,
						chunk: packet.chunk,
						pcmData,
					});
				} else {
					console.warn(`    Warning: packet at timestamp ${packet.timestamp} decoded to empty audio`);
				}
			} catch (error) {
				console.warn(`    Error decoding packet at timestamp ${packet.timestamp}:`, error.message);
			}
		}

		stream.packets = decodedPackets;
		console.log(`    Successfully decoded ${decodedPackets.length} packets`);
	}

	// Free decoder
	freeOpusDecoder(decoder);

	// Find global min/max timestamps
	let globalMinTimestamp = Infinity;
	let globalMaxTimestamp = -Infinity;

	for (const stream of streams.values()) {
		globalMinTimestamp = Math.min(globalMinTimestamp, stream.minTimestamp);
		globalMaxTimestamp = Math.max(globalMaxTimestamp, stream.maxTimestamp);
	}

	console.log(`\nGlobal timestamp range: ${globalMinTimestamp} to ${globalMaxTimestamp}`);

	// RTP timestamps can be very large (> 32-bit), so we work with relative offsets
	// The timestamps are in 48kHz units, convert to milliseconds
	const timestampToMs = (timestamp) => {
		return (timestamp / 48.0); // 48kHz timestamp units to milliseconds
	};

	// Calculate duration in milliseconds using relative offsets
	const startTimeMs = timestampToMs(globalMinTimestamp);
	const endTimeMs = timestampToMs(globalMaxTimestamp);
	const durationMs = (endTimeMs - startTimeMs) + MS_PER_PACKET;
	const totalSamples = Math.ceil((durationMs / 1000) * SAMPLE_RATE);
	const durationSeconds = (totalSamples / SAMPLE_RATE).toFixed(2);

	console.log(`Output duration: ${durationSeconds} seconds (${totalSamples} samples, ${durationMs.toFixed(0)}ms)`);
	console.log('Mixing audio streams...');

	const mixedAudio = new Int16Array(totalSamples);

	// Mix all streams by summing samples (already initialized to 0/silence)
	let totalSamplesMixed = 0;

	for (const stream of streams.values()) {
		for (const packet of stream.packets) {
			// Calculate offset based on relative timestamp (convert to samples)
			const packetTimeMs = timestampToMs(packet.timestamp);
			const relativeTimeMs = packetTimeMs - startTimeMs;
			const offset = Math.floor((relativeTimeMs / 1000) * SAMPLE_RATE);

			if (offset < 0 || offset >= mixedAudio.length) {
				console.warn(`    Warning: packet timestamp out of range (offset=${offset}), skipping`);
				continue;
			}

			// Mix by adding samples (with clipping protection)
			for (let i = 0; i < packet.pcmData.length && offset + i < mixedAudio.length; i++) {
				const mixed = mixedAudio[offset + i] + packet.pcmData[i];
				// Clip to 16-bit signed integer range
				mixedAudio[offset + i] = Math.max(-32768, Math.min(32767, mixed));
			}

			totalSamplesMixed += packet.pcmData.length;
		}
	}

	console.log(`Mixed ${totalSamplesMixed} total samples from ${streams.size} stream(s)`);

	// Write WAV file
	console.log(`\nWriting WAV file to ${outputFile}...`);
	writeWavFile(outputFile, mixedAudio, SAMPLE_RATE, CHANNELS);

	const fileSizeMB = (fs.statSync(outputFile).size / (1024 * 1024)).toFixed(2);
	console.log(`Done! Output file size: ${fileSizeMB} MB`);
}

function createOpusDecoder(nativeOpus, sampleRate, channels) {
	const native = new nativeOpus.OpusDecoder(sampleRate, channels);
	// Max output samples per channel for a single packet: 120 ms at the output rate.
	const maxFrameSize = Math.round(0.12 * sampleRate);
	return { native, channels, sampleRate, maxFrameSize };
}

function decodeOpusFrame(decoder, opusData) {
	// Native decode returns a Buffer of little-endian interleaved int16 PCM.
	const pcm = decoder.native.decode(Buffer.from(opusData), decoder.maxFrameSize, false);
	const samples = Math.floor(pcm.length / 2);
	// Copy into a standalone Int16Array (don't alias the addon-owned buffer).
	return Int16Array.from(new Int16Array(pcm.buffer, pcm.byteOffset, samples));
}

function freeOpusDecoder(decoder) {
	decoder.native.destroy();
}

function writeWavFile(filename, pcmData, sampleRate, channels) {
	const dataSize = pcmData.length * BYTES_PER_SAMPLE;
	const fileSize = 44 + dataSize;

	const buffer = Buffer.alloc(44 + dataSize);

	// RIFF header
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(fileSize - 8, 4);
	buffer.write('WAVE', 8);

	// fmt chunk
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16); // fmt chunk size
	buffer.writeUInt16LE(1, 20); // audio format (1 = PCM)
	buffer.writeUInt16LE(channels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28); // byte rate
	buffer.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample

	// data chunk
	buffer.write('data', 36);
	buffer.writeUInt32LE(dataSize, 40);

	// PCM data
	for (let i = 0; i < pcmData.length; i++) {
		buffer.writeInt16LE(pcmData[i], 44 + i * BYTES_PER_SAMPLE);
	}

	fs.writeFileSync(filename, buffer);
}
