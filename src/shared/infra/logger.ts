import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { currentLogContext } from './log-context';

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      mixin: currentLogContext,
      base: { service: 'wagering-processor' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: ['*.authorization', '*.money', '*.balance', '*.balanceBefore', '*.balanceAfter', '*.amount'],
        censor: '[redacted]',
      },
    },
    destination,
  );
}

export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
