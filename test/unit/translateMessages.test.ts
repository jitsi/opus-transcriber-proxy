/**
 * Tests for the shared /translate wire-message builders (src/translate/messages.ts) used by both the
 * Node server and the Worker handler — in particular that message_id uses the caller's sequence
 * counter, not Date.now() (whose collisions e719ea4 fixed).
 */
import { describe, it, expect } from 'vitest';
import {
	buildTranslationMediaMessage,
	buildTranslationTalkStartMessage,
	buildTranslationTalkStopMessage,
	buildTranslationTranscriptMessage,
} from '../../src/translate/messages';

describe('buildTranslationTranscriptMessage', () => {
	const data = { transcript: 'hola', targetLanguage: 'es', tag: '523834112-a0.es', isInterim: false };

	it('builds the documented wire shape', () => {
		const msg = buildTranslationTranscriptMessage(data, 0);
		expect(msg).toMatchObject({
			transcript: [{ text: 'hola' }],
			is_interim: false,
			language: 'es',
			message_id: 'translation-523834112-a0.es-0',
			type: 'realtime-translation-result',
			event: 'transcription-result',
			participant: { id: '523834112-a0.es' },
		});
		expect(typeof msg.timestamp).toBe('number');
	});

	it('two same-tag events in the same millisecond get distinct message_ids (seq, not Date.now())', () => {
		const a = buildTranslationTranscriptMessage(data, 1);
		const b = buildTranslationTranscriptMessage(data, 2);
		expect(a.message_id).not.toBe(b.message_id);
		expect(a.message_id).toBe('translation-523834112-a0.es-1');
		expect(b.message_id).toBe('translation-523834112-a0.es-2');
	});

	it('marks interim transcripts', () => {
		expect(buildTranslationTranscriptMessage({ ...data, isInterim: true }, 0).is_interim).toBe(true);
	});
});

describe('buildTranslationMediaMessage', () => {
	it('builds the mediajson media envelope with numeric fields', () => {
		const msg = buildTranslationMediaMessage({
			tag: '523834112-a0.es',
			chunk: 7,
			timestamp: 960,
			payload: 'b64==',
			sequenceNumber: 42,
		});
		expect(msg).toEqual({
			event: 'media',
			sequenceNumber: 42,
			media: { tag: '523834112-a0.es', chunk: 7, timestamp: 960, payload: 'b64==' },
		});
		expect(typeof msg.sequenceNumber).toBe('number');
		expect(typeof msg.media.chunk).toBe('number');
		expect(typeof msg.media.timestamp).toBe('number');
	});
});

describe('buildTranslationTalkStartMessage', () => {
	it('builds the mediajson start envelope augmented with the talk timestamp', () => {
		const msg = buildTranslationTalkStartMessage({ tag: '55555555-a0.hi', timestamp: 384000, sequenceNumber: 5 });
		expect(msg).toEqual({
			event: 'start',
			sequenceNumber: 5,
			start: {
				tag: '55555555-a0.hi',
				mediaFormat: { encoding: 'opus', sampleRate: 48000, channels: 1 },
				timestamp: 384000,
			},
		});
		expect(typeof msg.start.timestamp).toBe('number');
	});
});

describe('buildTranslationTalkStopMessage', () => {
	it('builds the mediajson stop envelope with tag, mediaInfo, and timestamp', () => {
		const msg = buildTranslationTalkStopMessage({
			tag: '55555555-a0.hi',
			timestamp: 960000,
			mediaInfo: { bytesSent: 4096, duration: 2000 },
			sequenceNumber: 6,
		});
		expect(msg).toEqual({
			event: 'stop',
			sequenceNumber: 6,
			stop: { tag: '55555555-a0.hi', mediaInfo: { bytesSent: 4096, duration: 2000 }, timestamp: 960000 },
		});
		expect(typeof msg.stop.timestamp).toBe('number');
		expect(typeof msg.stop.mediaInfo.bytesSent).toBe('number');
		expect(typeof msg.stop.mediaInfo.duration).toBe('number');
	});
});
