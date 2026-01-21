import { describe, it, expect } from '@jest/globals';

describe('Config Schema', () => {
  it('should export schema object', async () => {
    const schema = await import('../../src/services/config-schema.js');
    
    expect(schema.configSchema).toBeDefined();
    expect(typeof schema.configSchema).toBe('object');
  });

  it('should have core configuration keys', async () => {
    const { configSchema } = await import('../../src/services/config-schema.js');
    
    const keys = Object.keys(configSchema);
    
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some(k => k.startsWith('core.'))).toBe(true);
  });

  it('should have voice channel configuration', async () => {
    const { configSchema } = await import('../../src/services/config-schema.js');
    
    const keys = Object.keys(configSchema);
    
    expect(keys.some(k => k.startsWith('voicechannels.'))).toBe(true);
  });

  it('should have gamification configuration', async () => {
    const { configSchema } = await import('../../src/services/config-schema.js');
    
    const keys = Object.keys(configSchema);
    
    expect(keys.some(k => k.startsWith('gamification.'))).toBe(true);
  });

  it('should have schema values with types', async () => {
    const { configSchema } = await import('../../src/services/config-schema.js');
    
    const firstKey = Object.keys(configSchema)[0];
    const firstValue = configSchema[firstKey];
    
    expect(firstValue).toHaveProperty('type');
    expect(firstValue).toHaveProperty('default');
  });
});
