import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export interface TranscriptionMessage {
	transcript: Array<{ confidence?: number; text: string }>;
	is_interim: boolean;
	language?: string;
	message_id: string;
	type: 'transcription-result';
	event: 'transcription-result';
	participant: { id: string; ssrc?: string };
	timestamp: number;
}

export interface TranscriberProxyOptions {
	language: string | null;
}

export class TranscriberProxy extends EventEmitter {
	private readonly ws: WebSocket;
	private outgoingConnections: Map<string, OutgoingConnection>;
	private options: TranscriberProxyOptions;

	constructor(ws: WebSocket, options: TranscriberProxyOptions) {
		super({ captureRejections: true });
		this.ws = ws;
		this.options = options;
		this.outgoingConnections = new Map<string, OutgoingConnection>();

		this.ws.addEventListener('close', () => {
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

	private getConnection(tag: string): OutgoingConnection {
		// Check if connection already exists for this tag
		const connection = this.outgoingConnections.get(tag);
		if (connection !== undefined) {
			return connection;
		}

		// Create a new connection for this tag (no limit, no reuse)
		const newConnection = new OutgoingConnection(tag, this.options);

		newConnection.onInterimTranscription = (message) => {
			this.emit('interim_transcription', message);
		};
		newConnection.onCompleteTranscription = (message) => {
			this.emit('transcription', message);
		};
		newConnection.onClosed = (tag) => {
			this.outgoingConnections.delete(tag);
		};
		newConnection.onError = (tag, error) => {
			this.emit('error', tag, error);
		};

		this.outgoingConnections.set(tag, newConnection);
		console.log(`Created outgoing connection for tag: ${tag} (total connections: ${this.outgoingConnections.size})`);
		return newConnection;
	}

	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (tag) {
			const connection = this.getConnection(tag);
			connection.handleMediaEvent(parsedMessage);
		}
	}

	close(): void {
		this.outgoingConnections.forEach((connection) => {
			connection.close();
		});
		this.outgoingConnections.clear();
		this.ws.close();
		this.emit('closed');
	}
}
