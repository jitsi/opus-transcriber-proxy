/**
 * OpenTelemetry setup for metrics export via OTLP HTTP.
 * Only runs in the container (Node.js), not in the Cloudflare Worker.
 *
 * Telemetry is disabled if OTLP_ENDPOINT is not configured.
 */

import { metrics, Meter } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } from '@opentelemetry/semantic-conventions';
import { config } from './config';
import logger from './logger';

let meterProvider: MeterProvider | null = null;
let meter: Meter | null = null;

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

	// Build resource attributes
	const resourceAttributes: Record<string, string> = {
		[SEMRESATTRS_SERVICE_NAME]: 'opus-transcriber-proxy',
	};

	// Add environment if configured
	if (config.otlp.env) {
		resourceAttributes[SEMRESATTRS_DEPLOYMENT_ENVIRONMENT] = config.otlp.env;
		resourceAttributes['env'] = config.otlp.env; // Common label
	}

	// Add any custom resource attributes from config
	Object.assign(resourceAttributes, config.otlp.resourceAttributes);

	const resource = new Resource(resourceAttributes);

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
	logger.debug('Resource attributes:', JSON.stringify(resourceAttributes));
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
 * Gracefully shutdown telemetry.
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
