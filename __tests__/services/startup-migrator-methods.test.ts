import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/discord-logger.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/config.js');

describe('StartupMigrator Methods', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
    } as Client;
  });

  it('should have getInstance as a static method', async () => {
    const { StartupMigrator } = await import('../../src/services/startup-migrator.js');
    
    expect(typeof StartupMigrator.getInstance).toBe('function');
  });

  it('should return the same instance on multiple calls', async () => {
    const { StartupMigrator } = await import('../../src/services/startup-migrator.js');
    
    const instance1 = StartupMigrator.getInstance(mockClient as Client);
    const instance2 = StartupMigrator.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have runMigrations method', async () => {
    const { StartupMigrator } = await import('../../src/services/startup-migrator.js');
    
    const instance = StartupMigrator.getInstance(mockClient as Client);

    expect(typeof instance.runMigrations).toBe('function');
  });
});
