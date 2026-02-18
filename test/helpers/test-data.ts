/**
 * Test data fixtures and sample data for testing
 */

import type { TranscriptionMessage } from '../../src/transcriberproxy';
import type { OpusDecodedAudio } from '../../src/OpusDecoder/OpusDecoder';

// Sample Opus frames (base64 encoded)
// These are placeholder values - in real tests we'd use actual Opus data
export const TEST_OPUS_FRAMES = {
	valid_frame_20ms: 'T3B1c0ZyYW1lRGF0YTIwbXM=', // Placeholder base64
	valid_frame_40ms: 'T3B1c0ZyYW1lRGF0YTQwbXM=', // Placeholder base64
	invalid_frame: 'invalid_base64!!!',
	empty_frame: '',
};

// Sample PCM data
export const TEST_PCM_DATA = {
	silence_1sec: new Int16Array(24000).fill(0), // 1 second at 24kHz
	// Simple 440Hz tone generator (1 second at 24kHz)
	tone_440hz: (() => {
		const sampleRate = 24000;
		const frequency = 440;
		const duration = 1.0;
		const samples = sampleRate * duration;
		const buffer = new Int16Array(samples);
		for (let i = 0; i < samples; i++) {
			buffer[i] = Math.floor(Math.sin(2 * Math.PI * frequency * (i / sampleRate)) * 32767 * 0.5);
		}
		return buffer;
	})(),
};

// Sample decoded audio result
export const TEST_DECODED_AUDIO: OpusDecodedAudio = {
	audioData: new Uint8Array(TEST_PCM_DATA.silence_1sec.slice(0, 480).buffer), // 20ms at 24kHz
	samplesDecoded: 480,
	sampleRate: 24000,
	errors: [],
	channels: 1,
};

// WebSocket media events
export const TEST_MEDIA_EVENTS = {
	valid_media_event: {
		event: 'media',
		media: {
			tag: 'test-tag-123',
			payload: TEST_OPUS_FRAMES.valid_frame_20ms,
			chunk: 0,
			timestamp: 0,
		},
	},
	media_event_with_sequence: {
		event: 'media',
		media: {
			tag: 'test-tag-456',
			payload: TEST_OPUS_FRAMES.valid_frame_20ms,
			chunk: 5,
			timestamp: 100,
		},
	},
	media_event_missing_payload: {
		event: 'media',
		media: {
			tag: 'test-tag-789',
			chunk: 0,
			timestamp: 0,
		},
	},
	ping_event: {
		event: 'ping',
		id: 123,
	},
};

// Transcription messages
export const TEST_TRANSCRIPTION_MESSAGES = {
	interim_result: {
		transcript: [{ text: 'hello', confidence: 0.95 }],
		is_interim: true,
		message_id: 'msg-123',
		type: 'transcription-result',
		event: 'transcription-result',
		participant: { id: 'participant-1' },
		timestamp: Date.now(),
	} as TranscriptionMessage,
	final_result: {
		transcript: [{ text: 'hello world', confidence: 0.98 }],
		is_interim: false,
		message_id: 'msg-124',
		type: 'transcription-result',
		event: 'transcription-result',
		participant: { id: 'participant-1' },
		timestamp: Date.now(),
	} as TranscriptionMessage,
	result_with_language: {
		transcript: [{ text: 'bonjour', confidence: 0.92 }],
		is_interim: false,
		language: 'fr',
		message_id: 'msg-125',
		type: 'transcription-result',
		event: 'transcription-result',
		participant: { id: 'participant-2' },
		timestamp: Date.now(),
	} as TranscriptionMessage,
};

// OpenAI backend responses
export const OPENAI_RESPONSES = {
	session_created: {
		type: 'session.created',
		session: {
			id: 'session_123',
			model: 'gpt-4o-mini-transcribe',
		},
	},
	session_updated: {
		type: 'session.updated',
		session: {
			id: 'session_123',
		},
	},
	transcription_delta: {
		type: 'conversation.item.input_audio_transcription.delta',
		delta: 'hello',
		item_id: 'item-1',
		logprobs: [{ logprob: -0.05 }],
	},
	transcription_completed: {
		type: 'conversation.item.input_audio_transcription.completed',
		transcript: 'hello world',
		item_id: 'item-1',
		logprobs: [{ logprob: -0.02 }],
	},
	transcription_failed: {
		type: 'conversation.item.input_audio_transcription.failed',
		item_id: 'item-1',
		error: { message: 'Failed to transcribe' },
	},
	input_audio_buffer_committed: {
		type: 'input_audio_buffer.committed',
		item_id: 'item-1',
	},
	input_audio_buffer_speech_started: {
		type: 'input_audio_buffer.speech_started',
	},
	input_audio_buffer_speech_stopped: {
		type: 'input_audio_buffer.speech_stopped',
	},
	error: {
		type: 'error',
		error: {
			type: 'invalid_request_error',
			code: 'invalid_audio',
			message: 'Invalid audio format',
		},
	},
	error_empty_buffer: {
		type: 'error',
		error: {
			type: 'invalid_request_error',
			code: 'input_audio_buffer_commit_empty',
			message: 'Audio buffer is empty',
		},
	},
};

// Deepgram backend responses
export const DEEPGRAM_RESPONSES = {
	results_interim: {
		type: 'Results',
		channel: {
			alternatives: [{ transcript: 'hello', confidence: 0.95 }],
		},
		is_final: false,
	},
	results_final: {
		type: 'Results',
		channel: {
			alternatives: [
				{
					transcript: 'hello world',
					confidence: 0.98,
					languages: ['en'],
				},
			],
		},
		is_final: true,
	},
	results_empty: {
		type: 'Results',
		channel: {
			alternatives: [{ transcript: '', confidence: 0 }],
		},
		is_final: false,
	},
	utterance_end: {
		type: 'UtteranceEnd',
	},
	speech_started: {
		type: 'SpeechStarted',
	},
	metadata: {
		type: 'Metadata',
		request_id: 'req_123',
		model_info: {},
	},
	error: {
		type: 'Error',
		message: 'Audio format not supported',
	},
};

// Gemini backend responses
export const GEMINI_RESPONSES = {
	setup_complete: {
		setupComplete: {},
	},
	server_content: {
		serverContent: {
			modelTurn: {
				parts: [{ text: 'hello world' }],
			},
		},
	},
	server_content_empty: {
		serverContent: {
			modelTurn: {
				parts: [{ text: '' }],
			},
		},
	},
	server_content_multiple_parts: {
		serverContent: {
			modelTurn: {
				parts: [{ text: 'hello' }, { text: ' world' }],
			},
		},
	},
	error: {
		error: {
			code: 400,
			message: 'Invalid request',
			status: 'INVALID_ARGUMENT',
		},
	},
};

// Configuration fixtures
export const TEST_CONFIGS = {
	openai: {
		apiKey: 'test-openai-key',
		model: 'gpt-4o-mini-transcribe',
		transcriptionPrompt: 'Transcribe this audio.',
	},
	deepgram: {
		apiKey: 'test-deepgram-key',
		model: 'nova-2',
		encoding: 'linear16' as const,
		language: 'en',
		punctuate: true,
		diarize: false,
		includeLanguage: false,
	},
	gemini: {
		apiKey: 'test-gemini-key',
		model: 'gemini-2.0-flash-exp',
		transcriptionPrompt: 'Transcribe this audio.',
	},
	dummy: {
		enabled: true,
	},
};

// Participant info fixtures
export const TEST_PARTICIPANTS = {
	participant1: {
		id: 'abc123',
		ssrc: '456',
	},
	participant2: {
		id: 'def789',
		ssrc: '012',
	},
};

// Tag fixtures (endpoint-ssrc format)
export const TEST_TAGS = {
	valid_tag: 'abc123-456',
	simple_tag: 'test-tag',
	another_tag: 'def789-012',
};
