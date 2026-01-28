import { describe, it, expect } from '@jest/globals';

describe('Logger Utility', () => {
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
});
