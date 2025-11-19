import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';

export interface TranscriptionMessage {
	transcript: Array<{ text: string }>;
	is_interim: boolean;
	type: 'transcription-result';
	participant: { id: string; ssrc?: string };
	timestamp: number;
}

export class TranscriberProxy extends EventEmitter {
	private readonly ws: WebSocket;
	private outgoingConnections: Map<string, OutgoingConnection>;

	// Cloudflare workers allow a max of six concurrent outgoing connections.  Leave some room
	// in case we need to do separate fetch() calls or the like.  The JVB should have at most
	// three concurrent speakers.
	private MAX_OUTGOING_CONNECTIONS = 4;
	private env: Env;

	constructor(ws: WebSocket, env: Env) {
		super();
		this.ws = ws;
		this.env = env;
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
			// TODO: are there any other events that need to be handled?
			if (parsedMessage && parsedMessage.event === 'media') {
				this.handleMediaEvent(parsedMessage);
			}
		});
	}

	private oldestConnection(): OutgoingConnection | undefined {
		let oldestConnection: OutgoingConnection | undefined = undefined;
		for (const conn of this.outgoingConnections.values()) {
			if (oldestConnection === undefined || conn.lastMediaTime < oldestConnection.lastMediaTime) {
				oldestConnection = conn;
			}
		}
		return oldestConnection;
	}

	private getConnection(tag: string): OutgoingConnection {
		const connection = this.outgoingConnections.get(tag);
		if (connection !== undefined) {
			return connection;
		}

		if (this.outgoingConnections.size < this.MAX_OUTGOING_CONNECTIONS) {
			const newConnection = new OutgoingConnection(tag, this.env);

			newConnection.onInterimTranscription = (message) => {
				this.emit('interim_transcription', message);
			};
			newConnection.onCompleteTranscription = (message) => {
				this.emit('transcription', message);
			};
			newConnection.onClosed = (tag) => {
				this.outgoingConnections.delete(tag);
			};

			this.outgoingConnections.set(tag, newConnection);
			console.log(`Created outgoing connection entry for tag: ${tag}`);
			return newConnection;
		}

		// Otherwise reset and reuse the least-recently-used connection to support the new tag
		const connectionToReuse = this.oldestConnection()!;
		const oldTag = connectionToReuse.tag;
		this.outgoingConnections.delete(oldTag);
		connectionToReuse.reset(tag);
		this.outgoingConnections.set(tag, connectionToReuse);
		console.log(`Reused outgoing connection entry for tag: ${tag}, previously for tag: ${oldTag}`);

		return connectionToReuse;
	}

	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (tag) {
			const connection = this.getConnection(tag);
			connection.handleMediaEvent(parsedMessage);
		}
	}
}
