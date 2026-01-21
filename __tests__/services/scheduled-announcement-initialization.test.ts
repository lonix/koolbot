import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from 'discord.js';

// Mock all dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/models/scheduled-announcement.js', () => ({
  ScheduledAnnouncement: {
    find: jest.fn().mockResolvedValue([]),
  },
}));

describe('ScheduledAnnouncementService', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      channels: {
        fetch: jest.fn(),
      } as any,
    } as Client;
  });

  it('should have getInstance method', async () => {
    const { ScheduledAnnouncementService } = await import('../../src/services/scheduled-announcement-service.js');
    
    expect(typeof ScheduledAnnouncementService.getInstance).toBe('function');
  });

  it('should create singleton instance', async () => {
    const { ScheduledAnnouncementService } = await import('../../src/services/scheduled-announcement-service.js');
    
    const instance1 = ScheduledAnnouncementService.getInstance(mockClient as Client);
    const instance2 = ScheduledAnnouncementService.getInstance(mockClient as Client);

    expect(instance1).toBe(instance2);
  });
});
