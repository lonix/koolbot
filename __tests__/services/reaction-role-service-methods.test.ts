import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock dependencies
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/reaction-role-config.js', () => ({
  ReactionRoleConfig: {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

describe('ReactionRoleService Methods', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { ReactionRoleService } = await import('../../src/services/reaction-role-service.js');
    
    expect(typeof ReactionRoleService.getInstance).toBe('function');
  });

  it('should return singleton instance', async () => {
    const { ReactionRoleService } = await import('../../src/services/reaction-role-service.js');
    
    const instance1 = ReactionRoleService.getInstance(mockClient as Client);
    const instance2 = ReactionRoleService.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });

  it('should have listReactionRoles method', async () => {
    const { ReactionRoleService } = await import('../../src/services/reaction-role-service.js');
    
    const instance = ReactionRoleService.getInstance(mockClient as Client);

    expect(typeof instance.listReactionRoles).toBe('function');
  });
});
