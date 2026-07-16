// Wire-format builders for the messages the /translate endpoint sends back to the bridge, shared by
// the Node server (src/server.ts) and the Worker handler (worker/handleTranslate.ts) so the two
// serializers cannot drift (they had: the Worker copy reintroduced the Date.now() message_id
// collision that e719ea4 fixed with a per-connection sequence counter).
//
// Worker-safe: no Node imports (enforced by scripts/check-worker-safe.mjs).

/**
 * A /translate transcript message. The inner `type` is `realtime-translation-result` (not
 * `transcription-result`) so jitsi-meet recognizes it as a translation stream and does not render it
 * in the CC panel like a normal transcription. The outer `event` stays `transcription-result` because
 * JVB dispatches on `event` (via jicoco-mediajson) and only forwards payloads it recognizes — it
 * passes the inner `type` through to the client verbatim.
 */
export interface TranslationTranscriptMessage {
	transcript: Array<{ text: string }>;
	is_interim: boolean;
	language: string;
	message_id: string;
	type: 'realtime-translation-result';
	event: 'transcription-result';
	participant: { id?: string };
	timestamp: number;
}

/** A /translate translated-audio message (one Opus frame), per the mediajson protocol. */
export interface TranslationMediaMessage {
	event: 'media';
	sequenceNumber: number;
	media: { tag: string; chunk: number; timestamp: number; payload: string };
}

/**
 * The media format of the translated Opus audio, announced on each talk-start `start` event. The RTP clock rate is
 * 48000 Hz and the encoder is mono (see TranslatorConnection's opus encoder). The bridge does not act on these
 * fields for the sending-change notification, but the mediajson `start` event requires a mediaFormat.
 */
const TRANSLATED_AUDIO_MEDIA_FORMAT = { encoding: 'opus', sampleRate: 48000, channels: 1 } as const;

/**
 * A /translate talk-start message: the mediajson `start` event, augmented with the RTP `timestamp` at which a "talk"
 * (a contiguous run of translated audio) begins. Brackets the run of `media` frames, paired with a
 * {@link TranslationTalkStopMessage}. The bridge turns it into a client-facing SyntheticSourceSendingChangeEvent.
 */
export interface TranslationTalkStartMessage {
	event: 'start';
	sequenceNumber: number;
	start: {
		tag: string;
		mediaFormat: { encoding: string; sampleRate: number; channels: number };
		timestamp: number;
	};
}

/**
 * A /translate talk-stop message: the mediajson `stop` event, carrying the RTP `timestamp` at which the talk ends
 * and `mediaInfo` end-of-run statistics (`bytesSent` = total encoded Opus payload bytes, `duration` = ms).
 */
export interface TranslationTalkStopMessage {
	event: 'stop';
	sequenceNumber: number;
	stop: { tag: string; mediaInfo: { bytesSent: number; duration: number }; timestamp: number };
}

/**
 * Build the transcript message for a translation result. `seq` must be a monotonic per-connection
 * counter: two events for the same tag within the same millisecond would collide under Date.now().
 * `participant.id` is the input (export) source name the translation was produced from.
 */
export function buildTranslationTranscriptMessage(
	data: { transcript: string; targetLanguage: string; tag: string; isInterim: boolean },
	seq: number,
): TranslationTranscriptMessage {
	return {
		transcript: [{ text: data.transcript }],
		is_interim: data.isInterim,
		language: data.targetLanguage,
		message_id: `translation-${data.tag}-${seq}`,
		type: 'realtime-translation-result',
		event: 'transcription-result',
		participant: { id: data.tag },
		timestamp: Date.now(),
	};
}

/**
 * Build the translated-audio message for one Opus frame. The tag is the synthetic source name
 * verbatim (e.g. "523834112-a0.en") so the bridge's findSyntheticAudioSource(tag) matches the
 * colibri2-signaled synthetic source. The numeric fields stay numbers per the mediajson protocol
 * (the bridge/JVB parser expects numbers, not strings).
 */
export function buildTranslationMediaMessage(data: {
	tag: string;
	chunk: number;
	timestamp: number;
	payload: string;
	sequenceNumber: number;
}): TranslationMediaMessage {
	return {
		event: 'media',
		sequenceNumber: data.sequenceNumber,
		media: { tag: data.tag, chunk: data.chunk, timestamp: data.timestamp, payload: data.payload },
	};
}

/**
 * Build the talk-start message wrapping a run of translated audio for `tag`. `timestamp` is the RTP timestamp (48000
 * Hz, same timeline as the media frames) of the first frame of the talk.
 */
export function buildTranslationTalkStartMessage(data: {
	tag: string;
	timestamp: number;
	sequenceNumber: number;
}): TranslationTalkStartMessage {
	return {
		event: 'start',
		sequenceNumber: data.sequenceNumber,
		start: { tag: data.tag, mediaFormat: { ...TRANSLATED_AUDIO_MEDIA_FORMAT }, timestamp: data.timestamp },
	};
}

/**
 * Build the talk-stop message ending a run of translated audio for `tag`. `timestamp` is the RTP timestamp (48000 Hz)
 * marking the end of the talk; `mediaInfo` carries the run's `bytesSent` (encoded Opus payload) and `duration` (ms).
 */
export function buildTranslationTalkStopMessage(data: {
	tag: string;
	timestamp: number;
	mediaInfo: { bytesSent: number; duration: number };
	sequenceNumber: number;
}): TranslationTalkStopMessage {
	return {
		event: 'stop',
		sequenceNumber: data.sequenceNumber,
		stop: { tag: data.tag, mediaInfo: data.mediaInfo, timestamp: data.timestamp },
	};
}
