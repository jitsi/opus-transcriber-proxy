/**
 * Async test utilities for handling promises, events, and timing
 */

import { EventEmitter } from 'node:events';

/**
 * Wait for an EventEmitter to emit a specific event
 * @param emitter - The event emitter to listen to
 * @param event - The event name to wait for
 * @param timeout - Maximum time to wait in milliseconds (default: 1000ms)
 * @returns Promise that resolves with the event data
 */
export async function waitForEvent(emitter: EventEmitter, event: string, timeout: number = 1000): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			emitter.removeListener(event, handler);
			reject(new Error(`Timeout waiting for event '${event}' after ${timeout}ms`));
		}, timeout);

		const handler = (data: any) => {
			clearTimeout(timer);
			resolve(data);
		};

		emitter.once(event, handler);
	});
}

/**
 * Wait for a condition to become true
 * @param condition - Function that returns true when condition is met
 * @param timeout - Maximum time to wait in milliseconds (default: 1000ms)
 * @param interval - How often to check the condition in milliseconds (default: 10ms)
 * @returns Promise that resolves when condition is true
 */
export async function waitFor(condition: () => boolean, timeout: number = 1000, interval: number = 10): Promise<void> {
	const startTime = Date.now();

	while (!condition()) {
		if (Date.now() - startTime > timeout) {
			throw new Error(`Timeout waiting for condition after ${timeout}ms`);
		}
		await delay(interval);
	}
}

/**
 * Wait for all promises with a timeout
 * @param promises - Array of promises to wait for
 * @param timeout - Maximum time to wait in milliseconds (default: 1000ms)
 * @returns Promise that resolves with array of results
 */
export async function waitForAll(promises: Promise<any>[], timeout: number = 1000): Promise<any[]> {
	const timeoutPromise = new Promise((_, reject) => {
		setTimeout(() => reject(new Error(`Timeout waiting for all promises after ${timeout}ms`)), timeout);
	});

	return Promise.race([Promise.all(promises), timeoutPromise]) as Promise<any[]>;
}

/**
 * Create a promise that resolves after a delay
 * @param ms - Milliseconds to delay
 * @returns Promise that resolves after the delay
 */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flush the microtask queue (useful for draining promise chains)
 * @returns Promise that resolves after microtasks are drained
 */
export async function flushPromises(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait for multiple events in sequence
 * @param emitter - The event emitter to listen to
 * @param events - Array of event names to wait for in order
 * @param timeout - Maximum time to wait for each event in milliseconds
 * @returns Promise that resolves with array of event data
 */
export async function waitForEvents(
	emitter: EventEmitter,
	events: string[],
	timeout: number = 1000,
): Promise<any[]> {
	const results: any[] = [];
	for (const event of events) {
		const data = await waitForEvent(emitter, event, timeout);
		results.push(data);
	}
	return results;
}
