/**
 * Error that occurred during audio decoding
 */
export interface DecodeError {
	message: string;
	frameLength: number;
	frameNumber: number;
	inputBytes: number;
	outputSamples: number;
}

/**
 * Result of decoding an audio frame.
 * kind distinguishes normal decoded frames from loss-concealment frames (for metrics).
 */
export interface DecodedAudio {
	/** The decoded PCM audio data */
	audioData: Uint8Array;
	/** Number of samples decoded */
	samplesDecoded: number;
	/** Any errors that occurred during decoding */
	errors: DecodeError[];
	/** Whether this frame is a concealment frame generated to fill a packet-loss gap */
	kind?: 'normal' | 'concealment';
}

/**
 * Sentinel value for chunkNo / timestamp when chunk-tracking info is unavailable.
 * Decoders skip gap detection and concealment when this value is passed.
 */
export const NO_CHUNK_INFO = -1;

/**
 * Higher-level audio decoder interface.
 *
 * Each call to decodeChunk processes one incoming media payload together with
 * its sequence number and timestamp, allowing the implementation to:
 *  - detect and discard out-of-order (replayed) packets
 *  - detect packet-loss gaps and emit concealment audio before the real frame
 *
 * Returns null when the frame is out-of-order and should be discarded.
 * Returns an array (possibly empty on hard errors) otherwise; the array may
 * contain a concealment entry followed by the normally-decoded entry.
 */
export interface AudioDecoder {
	/**
	 * Promise that resolves when the decoder is ready to use
	 */
	readonly ready: Promise<void>;

	/**
	 * Decode one chunk of audio, performing gap detection and concealment.
	 * @param frame - The encoded audio frame
	 * @param chunkNo - Sequence number of this chunk (use NO_CHUNK_INFO if unavailable)
	 * @param timestamp - Audio timestamp (use NO_CHUNK_INFO if unavailable)
	 * @returns Array of DecodedAudio (may include a concealment frame before the real frame),
	 *          or null if the packet is out-of-order and should be discarded.
	 */
	decodeChunk(frame: Uint8Array, chunkNo: number, timestamp: number): DecodedAudio[] | null;

	/**
	 * Reset chunk-sequence tracking state.
	 * Call this when the audio stream is restarted or the session is reattached.
	 */
	reset(): void;

	/**
	 * Free decoder resources
	 */
	free(): void;
}
