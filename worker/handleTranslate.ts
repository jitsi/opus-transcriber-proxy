// Handles a /translate WebSocket entirely in the Worker (no container, no Durable Object): accepts
// the bridge WebSocket via WebSocketPair, drives the shared TranslatorProxy core with the Worker
// runtime (WASM codec, fetch-upgrade outbound to OpenAI), and serializes translated media +
// transcripts back to the bridge. The accepted socket keeps the Worker alive for the session; the
// bridge's periodic pings keep it active (no hibernation).
//
// Transcribe stays on the container (Worker outbound-connection limits); only translate — whose
// fan-out is bounded by (source × language) — runs here.

import type { Env } from './env';
import { TranslatorProxy } from '../src/translatorproxy';
import { normalizeTargetLanguage } from '../src/TranslatorConnection';
import type { IWebSocket } from '../src/translate/runtime';
import { createWorkerTranslationRuntime } from './translationRuntime';

export function handleTranslate(request: Request, env: Env): Response {
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected WebSocket upgrade', { status: 426 });
	}

	const runtime = createWorkerTranslationRuntime(env);
	if (!runtime.config.openaiApiKey) {
		console.error('Rejecting /translate: OpenAI API key not configured');
		return new Response('OpenAI API key not configured', { status: 503 });
	}

	const url = new URL(request.url);
	const sendBack = url.searchParams.get('sendBack') === 'true';
	const sendBackInterim = url.searchParams.get('sendBackInterim') === 'true';

	// Dev/replay path: seed target languages from ?lang= (the JVB drives `sources` instead).
	let initialLanguages: string[] = [];
	const langParam = url.searchParams.get('lang');
	if (langParam) {
		try {
			initialLanguages = langParam
				.split(',')
				.map((l) => l.trim())
				.filter((l) => l.length > 0)
				.map((l) => normalizeTargetLanguage(l));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return new Response(msg, { status: 400 });
		}
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();

	const proxy = new TranslatorProxy(server as unknown as IWebSocket, { initialLanguages }, runtime);

	proxy.on('audioFrame', (data: { tag: string; chunk: number; timestamp: number; payload: string; sequenceNumber: number }) => {
		if (!sendBack) return;
		server.send(
			JSON.stringify({
				event: 'media',
				sequenceNumber: data.sequenceNumber,
				media: { tag: data.tag, chunk: data.chunk, timestamp: data.timestamp, payload: data.payload },
			}),
		);
	});

	proxy.on('transcription', (data: { transcript: string; targetLanguage: string; tag: string; isInterim: boolean }) => {
		if (!sendBack) return;
		if (data.isInterim && !sendBackInterim) return;
		server.send(
			JSON.stringify({
				transcript: [{ text: data.transcript }],
				is_interim: data.isInterim,
				language: data.targetLanguage,
				message_id: `translation-${data.tag}-${Date.now()}`,
				// Inner type distinguishes translation from normal transcription; outer event stays
				// transcription-result so JVB forwards it verbatim. (See CLAUDE.md.)
				type: 'realtime-translation-result',
				event: 'transcription-result',
				participant: { id: data.tag },
				timestamp: Date.now(),
			}),
		);
	});

	proxy.on('error', (tag: string, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error in translation connection ${tag}: ${message}`);
	});

	proxy.on('closed', () => {
		try {
			server.close();
		} catch {
			// already closed
		}
	});

	return new Response(null, { status: 101, webSocket: client });
}
