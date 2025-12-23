import { TranslateConnection } from './TranslateConnection';
import { GeminiTranslateConnection } from './GeminiTranslateConnection';
import { EventEmitter } from 'node:events';

export interface TranslateProxyOptions {
	targetLanguage: string;
	instructions: string;
	voice?: string;
}

type AnyTranslateConnection = TranslateConnection | GeminiTranslateConnection;

export class TranslateProxy extends EventEmitter {
	private readonly ws: WebSocket;
	private translateConnections: Map<string, AnyTranslateConnection>;
	private env: Env;
	private options: TranslateProxyOptions;

	constructor(ws: WebSocket, env: Env, options: TranslateProxyOptions) {
		super({ captureRejections: true });
		this.ws = ws;
		this.env = env;
		this.options = options;
		this.translateConnections = new Map<string, TranslateConnection>();

		this.ws.addEventListener('close', () => {
			// Clean up all translation connections
			for (const conn of this.translateConnections.values()) {
				conn.close();
			}
			this.translateConnections.clear();
			this.ws.close();
			this.emit('closed');
		});

		this.ws.addEventListener('message', async (event) => {
			let parsedMessage;
			try {
				parsedMessage = JSON.parse(event.data as string);
			} catch (parseError) {
				console.error('Failed to parse message as JSON:', parseError);
				parsedMessage = { raw: event.data, parseError: true };
			}

			if (parsedMessage && parsedMessage.event === 'ping') {
				const pongMessage: { event: string; id?: number } = { event: 'pong' };
				if (typeof parsedMessage.id === 'number') {
					pongMessage.id = parsedMessage.id;
				}
				this.ws.send(JSON.stringify(pongMessage));
			} else if (parsedMessage && parsedMessage.event === 'media') {
				this.handleMediaEvent(parsedMessage);
			}
		});
	}

	private getConnection(tag: string): AnyTranslateConnection {
		const connection = this.translateConnections.get(tag);
		if (connection !== undefined) {
			return connection;
		}

		// Determine which provider to use based on environment variable
		const provider = this.env.TRANSLATION_PROVIDER || 'openai';
		console.log(`Creating ${provider} translation connection for tag: ${tag}`);

		// Create a new translation connection based on provider
		const newConnection: AnyTranslateConnection =
			provider === 'gemini'
				? new GeminiTranslateConnection(tag, this.env, {
						targetLanguage: this.options.targetLanguage,
						instructions: this.options.instructions,
				  })
				: new TranslateConnection(tag, this.env, {
						targetLanguage: this.options.targetLanguage,
						instructions: this.options.instructions,
						voice: this.options.voice,
				  });

		newConnection.onClosed = (tag) => {
			this.translateConnections.delete(tag);
		};
		newConnection.onError = (tag, error) => {
			this.emit('error', tag, error);
		};
		newConnection.onTranscription = (transcript, targetLanguage) => {
			console.log(`[TranslateProxy] onTranscription callback called for tag ${tag}, emitting event`);
			this.emit('transcription', { transcript, targetLanguage, tag });
		};
		newConnection.onAudioFrame = (tag, chunk, timestamp, payload, sequenceNumber) => {
			this.emit('audioFrame', { tag, chunk, timestamp, payload, sequenceNumber });
		};

		this.translateConnections.set(tag, newConnection);
		console.log(`Created ${provider} translation connection for tag: ${tag}, target language: ${this.options.targetLanguage}`);
		return newConnection;
	}

	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (tag) {
			const connection = this.getConnection(tag);
			connection.handleMediaEvent(parsedMessage);
		}
	}
}
