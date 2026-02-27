export interface AudioFormat {
	encoding: string;
	channels?: number;
	sampleRate?: number;
}

const VALID_INPUT_ENCODINGS = ['opus', 'ogg-opus', 'L16'] as const;

/**
 * Validates that an unknown value is a well-formed AudioFormat suitable for use
 * as a client-supplied input format (i.e. the mediaFormat field of a start event).
 * Throws a descriptive Error if validation fails.
 */
export function validateAudioFormat(format: unknown): AudioFormat {
	if (format === null || typeof format !== 'object') {
		throw new Error(`mediaFormat must be an object, got: ${JSON.stringify(format)}`);
	}

	const { encoding, channels, sampleRate } = format as Record<string, unknown>;

	if (typeof encoding !== 'string' || encoding === '') {
		throw new Error(`mediaFormat.encoding must be a non-empty string, got: ${JSON.stringify(encoding)}`);
	}

	if (!(VALID_INPUT_ENCODINGS as readonly string[]).includes(encoding)) {
		throw new Error(`mediaFormat.encoding must be one of [${VALID_INPUT_ENCODINGS.join(', ')}], got: ${JSON.stringify(encoding)}`);
	}

	if (channels !== undefined && (!Number.isInteger(channels) || (channels as number) <= 0)) {
		throw new Error(`mediaFormat.channels must be a positive integer, got: ${JSON.stringify(channels)}`);
	}

	if (sampleRate !== undefined && (typeof sampleRate !== 'number' || sampleRate <= 0)) {
		throw new Error(`mediaFormat.sampleRate must be a positive number, got: ${JSON.stringify(sampleRate)}`);
	}

	return format as AudioFormat;
}
