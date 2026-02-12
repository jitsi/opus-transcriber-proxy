/**
 * OpenTelemetry setup for metrics and logs export via OTLP HTTP.
 * Only runs in the container (Node.js), not in the Cloudflare Worker.
 *
 * Behavior:
 * - If OTLP_ENDPOINT is not configured: telemetry is disabled, no-op
 * - If OTLP endpoint is unavailable: logs are queued in memory (max 2048),
 *   retried with backoff, oldest dropped if queue fills. Console output
 *   continues working independently via Winston Console transport.
 * - Logs are batched (every 5s or 512 records) to reduce network overhead.
 */

import { metrics, Meter } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import * as logsAPI from '@opentelemetry/api-logs';
// Semantic convention attribute names (using strings to avoid deprecation warnings)
const ATTR_SERVICE_NAME = 'service.name';
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';
import { config } from './config';
import logger from './logger';

let meterProvider: MeterProvider | null = null;
let loggerProvider: LoggerProvider | null = null;
let meter: Meter | null = null;

/**
 * Create shared resource with common attributes for both metrics and logs.
 */
function createResource(): Resource {
	const resourceAttributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: 'opus-transcriber-proxy',
	};

	if (config.otlp.env) {
		resourceAttributes[ATTR_DEPLOYMENT_ENVIRONMENT] = config.otlp.env;
		resourceAttributes['env'] = config.otlp.env;
	}

	Object.assign(resourceAttributes, config.otlp.resourceAttributes);

	return new Resource(resourceAttributes);
}

/**
 * Initialize OpenTelemetry metrics.
 * Call this once at container startup, before creating any metrics instruments.
 */
export function initTelemetry(): void {
	if (!config.otlp.endpoint) {
		logger.info('OTLP_ENDPOINT not configured, telemetry disabled');
		return;
	}

	logger.info(`Initializing OpenTelemetry metrics, endpoint=${config.otlp.endpoint}`);

	const resource = createResource();

	// Create OTLP exporter
	const exporterConfig: { url: string; headers?: Record<string, string> } = {
		url: `${config.otlp.endpoint}/v1/metrics`,
	};

	// Add custom headers if configured (for authentication)
	if (Object.keys(config.otlp.headers).length > 0) {
		exporterConfig.headers = config.otlp.headers;
		logger.info('OTLP exporter configured with custom headers');
	}

	const exporter = new OTLPMetricExporter(exporterConfig);

	// Create metric reader with periodic export
	const metricReader = new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: config.otlp.exportIntervalMs,
	});

	// Create and register meter provider
	meterProvider = new MeterProvider({
		resource,
		readers: [metricReader],
	});

	metrics.setGlobalMeterProvider(meterProvider);
	meter = metrics.getMeter('opus-transcriber-proxy');

	logger.info('OpenTelemetry metrics initialized');
}

/**
 * Get the meter instance for creating instruments.
 * Returns a no-op meter if telemetry is disabled.
 */
export function getMeter(): Meter {
	if (meter) {
		return meter;
	}
	// Return global meter (will be no-op if not initialized)
	return metrics.getMeter('opus-transcriber-proxy');
}

/**
 * Check if telemetry is enabled and initialized.
 */
export function isTelemetryEnabled(): boolean {
	return meterProvider !== null;
}

/**
 * Gracefully shutdown telemetry metrics.
 * Call this on process termination to flush pending metrics.
 */
export async function shutdownTelemetry(): Promise<void> {
	if (meterProvider) {
		logger.info('Shutting down OpenTelemetry metrics...');
		try {
			await meterProvider.shutdown();
			logger.info('OpenTelemetry metrics shut down');
		} catch (error) {
			logger.error('Error shutting down OpenTelemetry:', error);
		}
	}
}

/**
 * Initialize OpenTelemetry logs.
 * Call this after initTelemetry() and before adding the OTLP transport to Winston.
 */
export function initTelemetryLogs(): void {
	if (!config.otlp.endpoint) {
		return; // Disabled if no endpoint
	}

	// Use console.log to avoid circular dependency with logger
	console.log(`Initializing OpenTelemetry logs, endpoint=${config.otlp.endpoint}/v1/logs`);

	const resource = createResource();

	const logExporterConfig: { url: string; headers?: Record<string, string> } = {
		url: `${config.otlp.endpoint}/v1/logs`,
	};

	if (Object.keys(config.otlp.headers).length > 0) {
		logExporterConfig.headers = config.otlp.headers;
	}

	const logExporter = new OTLPLogExporter(logExporterConfig);

	// Configure batch processor with explicit settings
	// - scheduledDelayMillis: flush interval (default 1s, we use 5s to reduce network overhead)
	// - maxQueueSize: max buffered logs before dropping oldest (default 2048)
	// - maxExportBatchSize: logs per HTTP request (default 512)
	const batchProcessor = new BatchLogRecordProcessor(logExporter, {
		scheduledDelayMillis: 5000, // Flush every 5 seconds
		maxQueueSize: 2048,
		maxExportBatchSize: 512,
		exportTimeoutMillis: 30000,
	});

	loggerProvider = new LoggerProvider({ resource });
	loggerProvider.addLogRecordProcessor(batchProcessor);

	logsAPI.logs.setGlobalLoggerProvider(loggerProvider);

	console.log('OpenTelemetry logs initialized');
}

/**
 * Gracefully shutdown telemetry logs.
 * Call this on process termination to flush pending logs.
 */
export async function shutdownTelemetryLogs(): Promise<void> {
	if (loggerProvider) {
		console.log('Shutting down OpenTelemetry logs...');
		try {
			await loggerProvider.shutdown();
			console.log('OpenTelemetry logs shut down');
		} catch (error) {
			console.error('Error shutting down OpenTelemetry logs:', error);
		}
	}
}
