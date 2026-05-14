import { TranslateConnection } from './TranslateConnection';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

export interface TranslateProxyOptions {
	targetLanguage: string;
	instructions: string;
	voice?: string;
	provider?: string;
}

export class TranslateProxy extends EventEmitter {
	private readonly ws: WebSocket;
	private translateConnections: Map<string, TranslateConnection>;
	private options: TranslateProxyOptions;

	constructor(ws: WebSocket, options: TranslateProxyOptions) {
		super({ captureRejections: true });
		this.ws = ws;
		this.options = options;
		this.translateConnections = new Map<string, TranslateConnection>();

		this.ws.addEventListener('close', () => {
			for (const conn of this.translateConnections.values()) {
				conn.close();
			}
			this.translateConnections.clear();
			this.emit('closed');
		});

		this.ws.addEventListener('message', (event) => {
			let parsedMessage;
			try {
				parsedMessage = JSON.parse(event.data as string);
			} catch (parseError) {
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

	private getConnection(tag: string): TranslateConnection {
		const connection = this.translateConnections.get(tag);
		if (connection !== undefined) {
			return connection;
		}

		const newConnection = new TranslateConnection(tag, {
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
			this.emit('transcription', { transcript, targetLanguage, tag });
		};
		newConnection.onAudioFrame = (tag, chunk, timestamp, payload, sequenceNumber) => {
			this.emit('audioFrame', { tag, chunk, timestamp, payload, sequenceNumber });
		};

		this.translateConnections.set(tag, newConnection);
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
