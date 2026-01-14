import winston from 'winston';

// Get log level from environment or default to 'info'
const logLevel = process.env.LOG_LEVEL || 'info';

// Create winston logger
const logger = winston.createLogger({
	level: logLevel,
	format: winston.format.combine(
		winston.format.timestamp({
			format: 'YYYY-MM-DD HH:mm:ss.SSS',
		}),
		winston.format.errors({ stack: true }),
		winston.format.splat(),
		winston.format.printf(({ level, message, timestamp, stack }) => {
			const levelUpper = level.toUpperCase().padEnd(5);
			if (stack) {
				return `${timestamp} [${levelUpper}] ${message}\n${stack}`;
			}
			return `${timestamp} [${levelUpper}] ${message}`;
		}),
	),
	transports: [new winston.transports.Console()],
});

// Export logger methods
export default logger;

// Also export convenience methods
export const info = logger.info.bind(logger);
export const debug = logger.debug.bind(logger);
export const warn = logger.warn.bind(logger);
export const error = logger.error.bind(logger);
