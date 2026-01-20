import { describe, it, expect } from '@jest/globals';
import winston from 'winston';

describe('Logger Error Handling', () => {
  describe('Logger Configuration', () => {
    it('should create logger with error serialization format', () => {
      const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

            if (stack) {
              log += `\n${stack}`;
            }

            const metaKeys = Object.keys(meta).filter(
              (key) => !['timestamp', 'level', 'message', 'stack'].includes(key),
            );
            if (metaKeys.length > 0) {
              log += `\n${JSON.stringify(meta, null, 2)}`;
            }

            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true, // Silent mode for testing
          }),
        ],
      });

      expect(logger).toBeDefined();
      expect(logger.level).toBe('info');
    });

    it('should handle Error objects without crashing', () => {
      const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const testError = new Error('Test error message');
      
      // Should not throw when logging error objects
      expect(() => {
        logger.error('Uncaught exception:', testError);
      }).not.toThrow();
    });

    it('should handle TypeError objects without crashing', () => {
      const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const typeError = new TypeError('Invalid type');
      
      expect(() => {
        logger.error('Type error occurred:', typeError);
      }).not.toThrow();
    });

    it('should handle ReferenceError objects without crashing', () => {
      const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const refError = new ReferenceError('Variable not defined');
      
      expect(() => {
        logger.error('Reference error:', refError);
      }).not.toThrow();
    });

    it('should handle custom error objects without crashing', () => {
      const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const customError = { message: 'Custom error object' };
      
      expect(() => {
        logger.error('Custom error:', customError);
      }).not.toThrow();
    });

    it('should handle metadata without crashing', () => {
      const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            const metaKeys = Object.keys(meta).filter(
              (key) => !['timestamp', 'level', 'message', 'stack'].includes(key),
            );
            if (metaKeys.length > 0) {
              log += `\n${JSON.stringify(meta, null, 2)}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      expect(() => {
        logger.error('Error with metadata', { userId: '123', action: 'login' });
      }).not.toThrow();
    });
  });
});
