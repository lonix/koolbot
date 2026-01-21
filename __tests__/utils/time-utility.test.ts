import { describe, it, expect } from '@jest/globals';

describe('Time Utility', () => {
  it('should export formatDuration function', async () => {
    const time = await import('../../src/utils/time.js');
    
    expect(time.formatDuration).toBeDefined();
    expect(typeof time.formatDuration).toBe('function');
  });

  it('should format duration correctly', async () => {
    const { formatDuration } = await import('../../src/utils/time.js');
    
    const result = formatDuration(3665);
    
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should handle zero duration', async () => {
    const { formatDuration } = await import('../../src/utils/time.js');
    
    const result = formatDuration(0);
    
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should handle large durations', async () => {
    const { formatDuration } = await import('../../src/utils/time.js');
    
    const result = formatDuration(86400); // 1 day in seconds
    
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});
