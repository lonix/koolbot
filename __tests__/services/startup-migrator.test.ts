import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client } from 'discord.js';
import { StartupMigrator } from '../../src/services/startup-migrator.js';
import { ConfigService } from '../../src/services/config-service.js';

jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/config.js');

describe('StartupMigrator', () => {
  let mockClient: Partial<Client>;
  let mockConfigService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
    } as Client;

    mockConfigService = {
      getBoolean: jest.fn().mockResolvedValue(false),
      getString: jest.fn().mockResolvedValue(null),
      triggerReload: jest.fn().mockResolvedValue(undefined),
    };

    (ConfigService.getInstance as jest.Mock).mockReturnValue(mockConfigService);
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = StartupMigrator.getInstance(mockClient as Client);
      const instance2 = StartupMigrator.getInstance(mockClient as Client);

      expect(instance1).toBe(instance2);
    });
  });
});
