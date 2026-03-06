import type { AudioDecoder, DecodedAudio } from './AudioDecoder';
import { NO_CHUNK_INFO } from './AudioDecoder';

const OGG_HEADER_MIN_SIZE = 27;
/** 'OggS' as a little-endian uint32 */
const OGG_CAPTURE_PATTERN = 0x5367674f;
const OPUS_HEAD_MAGIC = 'OpusHead';
const OPUS_TAGS_MAGIC = 'OpusTags';

type DecapsulatorState = 'expect_head' | 'expect_tags' | 'audio';

/**
 * Parse a single Ogg page that occupies all of `data` and return the
 * reassembled packets it contains.
 *
 * Lacing: a packet ends when a segment's size is < 255.  Segments of exactly
 * 255 bytes are concatenated with the next segment to form one larger packet.
 * Any partial packet left open by the last segment (i.e. the last segment is
 * exactly 255) is silently dropped; the caller assumes each Ogg page is
 * self-contained (no cross-page packet continuation).
 */
function parseOggPage(data: Uint8Array): Uint8Array[] {
	if (data.length < OGG_HEADER_MIN_SIZE) {
		throw new Error(`Ogg page too short: ${data.length} bytes (need at least ${OGG_HEADER_MIN_SIZE})`);
	}

	// Validate 'OggS' capture pattern
	const capture = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
	if (capture !== OGG_CAPTURE_PATTERN) {
		throw new Error('Missing OggS capture pattern — data is not an Ogg page');
	}

	if (data[4] !== 0) {
		throw new Error(`Unsupported Ogg version: ${data[4]}`);
	}

	const numSegments = data[26];
	if (data.length < OGG_HEADER_MIN_SIZE + numSegments) {
		throw new Error('Ogg page truncated: incomplete segment table');
	}

	const dataOffset = OGG_HEADER_MIN_SIZE + numSegments;
	let totalDataSize = 0;
	for (let i = 0; i < numSegments; i++) {
		totalDataSize += data[27 + i];
	}
	if (data.length < dataOffset + totalDataSize) {
		throw new Error('Ogg page truncated: incomplete segment data');
	}

	// Reassemble packets from laced segments
	const packets: Uint8Array[] = [];
	const parts: Uint8Array[] = [];
	let offset = dataOffset;

	for (let i = 0; i < numSegments; i++) {
		const segLen = data[27 + i];
		parts.push(data.subarray(offset, offset + segLen));
		offset += segLen;

		if (segLen < 255) {
			// End of packet: concatenate accumulated parts
			if (parts.length === 1) {
				packets.push(parts[0]);
			} else {
				const total = parts.reduce((acc, p) => acc + p.length, 0);
				const buf = new Uint8Array(total);
				let w = 0;
				for (const p of parts) {
					buf.set(p, w);
					w += p.length;
				}
				packets.push(buf);
			}
			parts.length = 0;
		}
	}
	// Any remaining parts form a packet that continues on the next page.
	// Since we treat each chunk as a complete page, drop it silently.

	return packets;
}

function readMagic(packet: Uint8Array, len: number): string {
	if (packet.length < len) return '';
	let s = '';
	for (let i = 0; i < len; i++) s += String.fromCharCode(packet[i]);
	return s;
}

/**
 * AudioDecoder that strips the Ogg container from an Ogg-Opus stream and
 * emits raw Opus packets.
 *
 * Each call to decodeChunk processes one complete Ogg page supplied as a
 * single chunk (the 'media' WebSocket event payload decoded from base64).
 *
 * The first page must contain an OpusHead identification packet; if it does
 * not, decodeChunk throws so the connection can be torn down cleanly.  The
 * second page must contain an OpusTags comment packet; it is silently
 * discarded.  All subsequent pages yield one DecodedAudio entry per Opus
 * packet (samplesDecoded is always 0 — no PCM decoding takes place here).
 *
 * Chunk-sequence tracking (out-of-order detection) operates at the Ogg page
 * level using the chunkNo supplied by the caller, consistent with every other
 * AudioDecoder in this codebase.
 */
export class OggOpusDecapsulator implements AudioDecoder {
	readonly ready: Promise<void> = Promise.resolve();
	private _state: DecapsulatorState = 'expect_head';
	private _lastChunkNo = NO_CHUNK_INFO;

	decodeChunk(page: Uint8Array, chunkNo: number, _timestamp: number): DecodedAudio[] | null {
		// Out-of-order / replayed page detection
		if (chunkNo !== NO_CHUNK_INFO && this._lastChunkNo !== NO_CHUNK_INFO) {
			if (chunkNo - this._lastChunkNo <= 0) {
				return null;
			}
		}
		if (chunkNo !== NO_CHUNK_INFO) {
			this._lastChunkNo = chunkNo;
		}

		const packets = parseOggPage(page);

		if (this._state === 'expect_head') {
			if (packets.length === 0 || readMagic(packets[0], 8) !== OPUS_HEAD_MAGIC) {
				const found = packets.length > 0 ? `"${readMagic(packets[0], 8)}"` : '(empty page)';
				throw new Error(
					`Expected OpusHead as first Ogg packet, got: ${found}. ` +
					`This Ogg stream does not appear to contain Opus audio.`,
				);
			}
			this._state = 'expect_tags';
			return []; // header page — no audio output
		}

		if (this._state === 'expect_tags') {
			this._state = 'audio';
			// Skip the page if it is an OpusTags comment header; otherwise
			// fall through and treat it as the first audio page.
			if (packets.length > 0 && readMagic(packets[0], 8) === OPUS_TAGS_MAGIC) {
				return []; // comment header — no audio output
			}
		}

		// Audio page: return each laced Opus packet as a separate DecodedAudio.
		return packets.map(
			(pkt): DecodedAudio => ({
				audioData: pkt,
				samplesDecoded: 0,
				errors: [],
				kind: 'normal',
			}),
		);
	}

	/**
	 * Reset chunk-sequence tracking.  Does NOT reset the header-validation
	 * state machine because a reattached session continues an existing Ogg
	 * stream — new OpusHead/OpusTags pages are not re-sent on reconnect.
	 */
	reset(): void {
		this._lastChunkNo = NO_CHUNK_INFO;
	}

	free(): void {
		// No resources to release
	}
}
