import { describe, it, expect } from 'vitest';
import { OggOpusDecapsulator } from '../../src/OggOpusDecapsulator';
import { NO_CHUNK_INFO } from '../../src/AudioDecoder';

// ---------------------------------------------------------------------------
// Real Ogg-Opus pages from voximplant-ogg-opus-capture.tar.gz
// Captured from a VoxImplant staging environment, 2026-03-03.
// Each WebSocket media chunk is exactly one complete Ogg page.
// Encoder: Lavf60.16.100 (FFmpeg), mono 48 kHz, 20 ms frames (960 samples).
// ---------------------------------------------------------------------------
function hex(s: string): Uint8Array {
	const bytes = new Uint8Array(s.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

// chunk 0 — OpusHead identification header (47 bytes)
const REAL_OPUS_HEAD = hex(
	'4f67675300020000000000000000193d173500000000553a4ba7' +
	'01134f707573486561640101380180bb0000000000',
);
// chunk 1 — OpusTags comment header (82 bytes, vendor = "Lavf60.16.100")
const REAL_OPUS_TAGS = hex(
	'4f67675300000000000000000000193d173501000000e8dd8883' +
	'01364f707573546167730d0000004c61766636302e31362e3130' +
	'300100000015000000656e636f6465723d4c61766636302e3136' +
	'2e313030',
);
// chunk 2 — first audio page: granule 960 (20 ms), 1 segment of 24 bytes
const REAL_AUDIO_PAGE_0 = hex(
	'4f6767530000c003000000000000193d17350200000074da4078' +
	'0118780bf9b96de121939a22f9b9e1dbf7dddf317472f74ddd9b',
);
// Extracted Opus frame from chunk 2 (the 24 payload bytes)
const REAL_OPUS_FRAME_0 = hex('780bf9b96de121939a22f9b9e1dbf7dddf317472f74ddd9b');
// chunk 3 — second audio page: granule 1920 (40 ms), 1 segment of 28 bytes
const REAL_AUDIO_PAGE_1 = hex(
	'4f67675300008007000000000000193d17350300000087c6bdee' +
	'011c7809f57260f110121a36f463040c451434421bf7e83cc6c4' +
	'5b67bb8a',
);
// chunk 4 — third audio page: granule 2880 (60 ms), 1 segment of 32 bytes
const REAL_AUDIO_PAGE_2 = hex(
	'4f6767530000400b000000000000193d173504000000835d1a38' +
	'01207886f8c8d7f0b5459cda75f931b6b69d67fe42a23f4850fd' +
	'b5e53df229565da3',
);

// ---------------------------------------------------------------------------
// Ogg page builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid Ogg page containing the given packets.
 * Lacing: each packet is split into 255-byte segments; the final segment is
 * < 255 to mark the end of the packet.  A zero-length packet is represented
 * by a single segment of length 0.
 *
 * The checksum field is left as zero; OggOpusDecapsulator does not verify it.
 */
function buildOggPage(
	sequenceNumber: number,
	headerType: number,
	packets: Uint8Array[],
): Uint8Array {
	// Build segment table using lacing
	const segments: number[] = [];
	for (const pkt of packets) {
		let remaining = pkt.length;
		while (remaining >= 255) {
			segments.push(255);
			remaining -= 255;
		}
		segments.push(remaining); // terminal segment (< 255)
	}

	const headerSize = 27 + segments.length;
	const dataSize = packets.reduce((a, p) => a + p.length, 0);
	const page = new Uint8Array(headerSize + dataSize);

	// Capture pattern 'OggS'
	page[0] = 0x4f; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53;
	page[4] = 0; // version
	page[5] = headerType;
	// granulePosition bytes 6-13 — left as 0
	// serialNumber bytes 14-17 — left as 0
	// sequenceNumber bytes 18-21 (LE)
	page[18] = sequenceNumber & 0xff;
	page[19] = (sequenceNumber >> 8) & 0xff;
	page[20] = (sequenceNumber >> 16) & 0xff;
	page[21] = (sequenceNumber >> 24) & 0xff;
	// checksum bytes 22-25 — left as 0 (not validated)
	page[26] = segments.length;

	// Segment table
	for (let i = 0; i < segments.length; i++) {
		page[27 + i] = segments[i];
	}

	// Packet data
	let offset = 27 + segments.length;
	for (const pkt of packets) {
		page.set(pkt, offset);
		offset += pkt.length;
	}

	return page;
}

function buildOpusHeadPacket(channels = 1, sampleRate = 48000): Uint8Array {
	const buf = new Uint8Array(19);
	const magic = 'OpusHead';
	for (let i = 0; i < 8; i++) buf[i] = magic.charCodeAt(i);
	buf[8] = 1; // version
	buf[9] = channels;
	// pre-skip = 0 (bytes 10-11)
	buf[12] = sampleRate & 0xff;
	buf[13] = (sampleRate >> 8) & 0xff;
	buf[14] = (sampleRate >> 16) & 0xff;
	buf[15] = (sampleRate >> 24) & 0xff;
	// output gain = 0 (bytes 16-17)
	buf[18] = 0; // channel mapping family
	return buf;
}

function buildOpusTagsPacket(): Uint8Array {
	const buf = new Uint8Array(16);
	const magic = 'OpusTags';
	for (let i = 0; i < 8; i++) buf[i] = magic.charCodeAt(i);
	// vendor string length = 0 (bytes 8-11), user comment list length = 0 (bytes 12-15)
	return buf;
}

/** A fake Opus audio packet — real content doesn't matter for decapsulator tests */
function audioPacket(id = 0): Uint8Array {
	return new Uint8Array([0x78, id & 0xff, 0x00, 0x01]);
}

// ---------------------------------------------------------------------------

describe('OggOpusDecapsulator', () => {
	describe('Construction and readiness', () => {
		it('is immediately ready', async () => {
			const dec = new OggOpusDecapsulator();
			await expect(dec.ready).resolves.toBeUndefined();
		});
	});

	describe('Header validation', () => {
		it('accepts a valid OpusHead first page and returns empty array', () => {
			const dec = new OggOpusDecapsulator();
			const page = buildOggPage(0, 0x02, [buildOpusHeadPacket()]);
			const result = dec.decodeChunk(page, 0, NO_CHUNK_INFO);
			expect(result).toEqual([]);
		});

		it('throws when the first page does not start with OpusHead', () => {
			const dec = new OggOpusDecapsulator();
			const page = buildOggPage(0, 0x02, [audioPacket()]);
			expect(() => dec.decodeChunk(page, 0, NO_CHUNK_INFO)).toThrow('OpusHead');
		});

		it('throws with a helpful message when first packet has wrong magic', () => {
			const dec = new OggOpusDecapsulator();
			const wrongMagic = new Uint8Array(19);
			const s = 'Vorbis\x01\x00'; // 8 bytes
			for (let i = 0; i < 8; i++) wrongMagic[i] = s.charCodeAt(i);
			const page = buildOggPage(0, 0x02, [wrongMagic]);
			expect(() => dec.decodeChunk(page, 0, NO_CHUNK_INFO)).toThrow('Ogg stream does not appear to contain Opus');
		});

		it('throws when first page is empty (no packets)', () => {
			const dec = new OggOpusDecapsulator();
			const page = buildOggPage(0, 0x02, []);
			expect(() => dec.decodeChunk(page, 0, NO_CHUNK_INFO)).toThrow('OpusHead');
		});

		it('skips OpusTags page and returns empty array', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(buildOggPage(0, 0x02, [buildOpusHeadPacket()]), 0, NO_CHUNK_INFO);
			const tagsPage = buildOggPage(1, 0x00, [buildOpusTagsPacket()]);
			const result = dec.decodeChunk(tagsPage, 1, NO_CHUNK_INFO);
			expect(result).toEqual([]);
		});

		it('treats non-OpusTags second page as first audio page', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(buildOggPage(0, 0x02, [buildOpusHeadPacket()]), 0, NO_CHUNK_INFO);
			// Send an audio packet where OpusTags would be
			const page = buildOggPage(1, 0x00, [audioPacket(1)]);
			const result = dec.decodeChunk(page, 1, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
			expect(result!).toHaveLength(1);
			expect(result![0].audioData).toEqual(audioPacket(1));
		});
	});

	describe('Audio pages', () => {
		function makeDecapsulatorInAudioState(): OggOpusDecapsulator {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(buildOggPage(0, 0x02, [buildOpusHeadPacket()]), 0, NO_CHUNK_INFO);
			dec.decodeChunk(buildOggPage(1, 0x00, [buildOpusTagsPacket()]), 1, NO_CHUNK_INFO);
			return dec;
		}

		it('returns one DecodedAudio per Opus packet in the page', () => {
			const dec = makeDecapsulatorInAudioState();
			const pkt1 = audioPacket(1);
			const pkt2 = audioPacket(2);
			const page = buildOggPage(2, 0x00, [pkt1, pkt2]);
			const result = dec.decodeChunk(page, 2, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
			expect(result!).toHaveLength(2);
			expect(result![0].audioData).toEqual(pkt1);
			expect(result![1].audioData).toEqual(pkt2);
		});

		it('each result has samplesDecoded=0, no errors, kind=normal', () => {
			const dec = makeDecapsulatorInAudioState();
			const page = buildOggPage(2, 0x00, [audioPacket(1)]);
			const result = dec.decodeChunk(page, 2, NO_CHUNK_INFO)!;
			expect(result[0].samplesDecoded).toBe(0);
			expect(result[0].errors).toHaveLength(0);
			expect(result[0].kind).toBe('normal');
		});

		it('returns empty array for a page with no segments (no packets)', () => {
			const dec = makeDecapsulatorInAudioState();
			const page = buildOggPage(2, 0x00, []);
			const result = dec.decodeChunk(page, 2, NO_CHUNK_INFO);
			expect(result).toEqual([]);
		});

		it('handles a single large packet spanning multiple 255-byte segments', () => {
			const dec = makeDecapsulatorInAudioState();
			// 600-byte packet: requires three segments (255 + 255 + 90)
			const large = new Uint8Array(600);
			for (let i = 0; i < 600; i++) large[i] = i % 256;
			const page = buildOggPage(2, 0x00, [large]);
			const result = dec.decodeChunk(page, 2, NO_CHUNK_INFO)!;
			expect(result).toHaveLength(1);
			expect(result[0].audioData).toEqual(large);
		});

		it('works without chunkNo (NO_CHUNK_INFO)', () => {
			const dec = makeDecapsulatorInAudioState();
			const r1 = dec.decodeChunk(buildOggPage(2, 0, [audioPacket(1)]), NO_CHUNK_INFO, NO_CHUNK_INFO);
			const r2 = dec.decodeChunk(buildOggPage(3, 0, [audioPacket(2)]), NO_CHUNK_INFO, NO_CHUNK_INFO);
			expect(r1).not.toBeNull();
			expect(r2).not.toBeNull();
		});
	});

	describe('Out-of-order detection', () => {
		function makeReady(): OggOpusDecapsulator {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(buildOggPage(0, 0x02, [buildOpusHeadPacket()]), 0, NO_CHUNK_INFO);
			dec.decodeChunk(buildOggPage(1, 0x00, [buildOpusTagsPacket()]), 1, NO_CHUNK_INFO);
			dec.decodeChunk(buildOggPage(2, 0x00, [audioPacket(1)]), 2, NO_CHUNK_INFO);
			return dec;
		}

		it('returns null for an out-of-order page', () => {
			const dec = makeReady();
			const result = dec.decodeChunk(buildOggPage(0, 0, [audioPacket(0)]), 1, NO_CHUNK_INFO);
			expect(result).toBeNull();
		});

		it('returns null for a replayed page (same chunkNo)', () => {
			const dec = makeReady();
			const result = dec.decodeChunk(buildOggPage(2, 0, [audioPacket(0)]), 2, NO_CHUNK_INFO);
			expect(result).toBeNull();
		});

		it('accepts pages with chunkNo gaps (pages dropped at sender)', () => {
			const dec = makeReady();
			const result = dec.decodeChunk(buildOggPage(10, 0, [audioPacket(10)]), 10, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
			expect(result!).toHaveLength(1);
		});
	});

	describe('reset()', () => {
		it('clears chunk tracking so a lower chunkNo is accepted', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(buildOggPage(0, 0x02, [buildOpusHeadPacket()]), 0, NO_CHUNK_INFO);
			dec.decodeChunk(buildOggPage(1, 0x00, [buildOpusTagsPacket()]), 5, NO_CHUNK_INFO);
			dec.reset();
			const result = dec.decodeChunk(buildOggPage(2, 0, [audioPacket(1)]), 1, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
		});

		it('does not reset header state — stream continues without re-sending headers', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(buildOggPage(0, 0x02, [buildOpusHeadPacket()]), 0, NO_CHUNK_INFO);
			dec.decodeChunk(buildOggPage(1, 0x00, [buildOpusTagsPacket()]), 1, NO_CHUNK_INFO);
			dec.reset(); // simulates session reattach
			// Next chunk should be treated as audio, not a header
			const result = dec.decodeChunk(buildOggPage(2, 0, [audioPacket(1)]), 2, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
			expect(result!).toHaveLength(1);
		});
	});

	describe('free()', () => {
		it('does not throw', () => {
			const dec = new OggOpusDecapsulator();
			expect(() => dec.free()).not.toThrow();
		});
	});

	describe('Ogg page parsing errors', () => {
		it('throws for data shorter than minimum Ogg header', () => {
			const dec = new OggOpusDecapsulator();
			expect(() =>
				dec.decodeChunk(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), 0, NO_CHUNK_INFO),
			).toThrow('too short');
		});

		it('throws for missing OggS capture pattern', () => {
			const dec = new OggOpusDecapsulator();
			const bad = new Uint8Array(27); // all zeros, wrong capture
			expect(() => dec.decodeChunk(bad, 0, NO_CHUNK_INFO)).toThrow('capture pattern');
		});

		it('throws for unsupported Ogg version', () => {
			const dec = new OggOpusDecapsulator();
			const page = buildOggPage(0, 0x02, [buildOpusHeadPacket()]);
			page[4] = 1; // corrupt version byte
			expect(() => dec.decodeChunk(page, 0, NO_CHUNK_INFO)).toThrow('version');
		});
	});

	// -------------------------------------------------------------------------
	// Tests using real captured pages from voximplant-ogg-opus-capture.tar.gz
	// -------------------------------------------------------------------------
	describe('Real VoxImplant capture', () => {
		it('accepts the real OpusHead page without error', () => {
			const dec = new OggOpusDecapsulator();
			const result = dec.decodeChunk(REAL_OPUS_HEAD, 0, NO_CHUNK_INFO);
			expect(result).toEqual([]); // header page — no audio output
		});

		it('accepts the real OpusTags page without error', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(REAL_OPUS_HEAD, 0, NO_CHUNK_INFO);
			const result = dec.decodeChunk(REAL_OPUS_TAGS, 1, NO_CHUNK_INFO);
			expect(result).toEqual([]); // comment header — no audio output
		});

		it('extracts the correct Opus frame bytes from the first audio page', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(REAL_OPUS_HEAD, 0, NO_CHUNK_INFO);
			dec.decodeChunk(REAL_OPUS_TAGS, 1, NO_CHUNK_INFO);
			const result = dec.decodeChunk(REAL_AUDIO_PAGE_0, 2, NO_CHUNK_INFO)!;
			expect(result).toHaveLength(1);
			expect(result[0].audioData).toEqual(REAL_OPUS_FRAME_0);
			expect(result[0].samplesDecoded).toBe(0);
			expect(result[0].errors).toHaveLength(0);
			expect(result[0].kind).toBe('normal');
		});

		it('processes three sequential audio pages and returns one frame each', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(REAL_OPUS_HEAD, 0, NO_CHUNK_INFO);
			dec.decodeChunk(REAL_OPUS_TAGS, 1, NO_CHUNK_INFO);

			const r0 = dec.decodeChunk(REAL_AUDIO_PAGE_0, 2, NO_CHUNK_INFO)!;
			const r1 = dec.decodeChunk(REAL_AUDIO_PAGE_1, 3, NO_CHUNK_INFO)!;
			const r2 = dec.decodeChunk(REAL_AUDIO_PAGE_2, 4, NO_CHUNK_INFO)!;

			expect(r0).toHaveLength(1);
			expect(r1).toHaveLength(1);
			expect(r2).toHaveLength(1);

			// Frame sizes from captured data: 24, 28, 32 bytes
			expect(r0[0].audioData.length).toBe(24);
			expect(r1[0].audioData.length).toBe(28);
			expect(r2[0].audioData.length).toBe(32);
		});

		it('rejects a replayed audio page (same chunkNo)', () => {
			const dec = new OggOpusDecapsulator();
			dec.decodeChunk(REAL_OPUS_HEAD, 0, NO_CHUNK_INFO);
			dec.decodeChunk(REAL_OPUS_TAGS, 1, NO_CHUNK_INFO);
			dec.decodeChunk(REAL_AUDIO_PAGE_0, 2, NO_CHUNK_INFO);
			const result = dec.decodeChunk(REAL_AUDIO_PAGE_0, 2, NO_CHUNK_INFO);
			expect(result).toBeNull();
		});
	});
});
