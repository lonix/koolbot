import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/permissions-service.js');
jest.mock('../../src/utils/logger.js');

describe('CommandManager Methods', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      commands: new Map(),
      application: {
        commands: {
          set: jest.fn().mockResolvedValue([]),
        } as any,
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { CommandManager } = await import('../../src/services/command-manager.js');
    
    expect(typeof CommandManager.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { CommandManager } = await import('../../src/services/command-manager.js');
    
    const instance1 = CommandManager.getInstance(mockClient as Client);
    const instance2 = CommandManager.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have loadCommandsDynamically method', async () => {
    const { CommandManager } = await import('../../src/services/command-manager.js');
    
    const instance = CommandManager.getInstance(mockClient as Client);

    expect(typeof instance.loadCommandsDynamically).toBe('function');
  });

  it('should have registerCommands method', async () => {
    const { CommandManager } = await import('../../src/services/command-manager.js');
    
    const instance = CommandManager.getInstance(mockClient as Client);

    expect(typeof instance.registerCommands).toBe('function');
  });
});
