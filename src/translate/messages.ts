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
