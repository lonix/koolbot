import { describe, it, expect, afterEach } from '@jest/globals';

describe('Logger Utility', () => {
  const originalDebug = process.env.DEBUG;

  afterEach(() => {
    process.env.DEBUG = originalDebug;
  });

  it('should export logger object', async () => {
    const logger = await import('../../src/utils/logger.js');
    
    expect(logger.default).toBeDefined();
  });

  it('should have logging methods', async () => {
    const { default: logger } = await import('../../src/utils/logger.js');
    
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should not throw when calling logger methods', async () => {
    const { default: logger } = await import('../../src/utils/logger.js');
    
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.debug('test')).not.toThrow();
  });

  it('should evaluate debug mode from process.env.DEBUG', async () => {
    const { isDebugMode } = await import('../../src/utils/logger.js');

    process.env.DEBUG = 'true';
    expect(isDebugMode()).toBe(true);

    process.env.DEBUG = 'false';
    expect(isDebugMode()).toBe(false);

    process.env.DEBUG = '';
    expect(isDebugMode()).toBe(false);

    process.env.DEBUG = '1';
    expect(isDebugMode()).toBe(false);

    delete process.env.DEBUG;
    expect(isDebugMode()).toBe(false);
  });
});
