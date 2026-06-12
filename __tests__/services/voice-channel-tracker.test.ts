import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Client, VoiceState, GuildMember, VoiceChannel } from 'discord.js';

// Do NOT override the global mongoose mock from setup.ts — rely on it for stable jest.fn() instances.
// The global mock's model() returns a shared object so its methods can be reconfigured per-test.

jest.mock('../../src/utils/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/achievements-service.js', () => ({
  AchievementsService: {
    getInstance: jest.fn(() => ({
      checkAndAwardAccolades: jest.fn().mockResolvedValue([]),
      checkAndAwardAchievements: jest.fn().mockResolvedValue(undefined),
      notifyUserOfAccolades: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

// Static imports — mocks are registered before these load (jest.mock is hoisted)
import { VoiceChannelTracker } from '../../src/services/voice-channel-tracker.js';
import { VoiceChannelTracking } from '../../src/models/voice-channel-tracking.js';

// Helper to create a configured tracker with injected mock config service
function createTracker(mockClient: Partial<Client>) {
  const tracker = VoiceChannelTracker.getInstance(mockClient as Client);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue('mongodb://localhost/test'),
    getBoolean: jest.fn().mockResolvedValue(false),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
    triggerReload: jest.fn().mockResolvedValue(undefined),
  };
  // Inject mock config service and mark as connected (established pattern from codebase)
  (tracker as never)['configService'] = mockConfigService;
  (tracker as never)['isConnected'] = true;

  return { tracker, mockConfigService };
}

describe('VoiceChannelTracker', () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    // Reconfigure the global mock's model methods for each test.
    // VoiceChannelTracking comes from the real module loaded via the global mongoose mock,
    // which returns a stable shared jest.fn() object from mockReturnValue().
    (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);
    (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockResolvedValue({});
    (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

    mockClient = {
      users: { fetch: jest.fn() } as any,
      channels: { fetch: jest.fn() } as any,
    };

    // Reset singleton between tests
    (VoiceChannelTracker as unknown as { instance: unknown }).instance = undefined;
  });

  describe('singleton pattern', () => {
    it('should create a singleton instance', () => {
      const instance1 = VoiceChannelTracker.getInstance(mockClient as Client);
      const instance2 = VoiceChannelTracker.getInstance(mockClient as Client);
      expect(instance1).toBe(instance2);
    });

    it('should create an instance with a client', () => {
      expect(VoiceChannelTracker.getInstance(mockClient as Client)).toBeDefined();
    });
  });

  describe('getActiveSession', () => {
    it('should return null for unknown user', () => {
      const { tracker } = createTracker(mockClient);
      expect(tracker.getActiveSession('unknown-user')).toBeNull();
    });
  });

  describe('handleVoiceStateUpdate', () => {
    it('should return early when voice tracking is disabled', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.handleVoiceStateUpdate(
        { member: null, channel: null } as unknown as VoiceState,
        { member: null, channel: null } as unknown as VoiceState,
      );
      expect(VoiceChannelTracking.findOne).not.toHaveBeenCalled();
    });

    it('should handle missing member gracefully when tracking enabled', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);

      await expect(
        tracker.handleVoiceStateUpdate(
          { member: null, channel: null } as unknown as VoiceState,
          { member: null, channel: null } as unknown as VoiceState,
        )
      ).resolves.not.toThrow();
    });

    it('should handle user joining a channel (tracking enabled)', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const mockMember = {
        id: 'user123',
        displayName: 'TestUser',
        guild: { channels: { cache: { get: jest.fn().mockReturnValue(null) } } },
      } as unknown as GuildMember;
      const mockChannel = { id: 'channel123', name: 'TestChannel' } as unknown as VoiceChannel;

      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: null } as unknown as VoiceState,
        { member: mockMember, channel: mockChannel } as unknown as VoiceState,
      );

      const session = tracker.getActiveSession('user123');
      expect(session).not.toBeNull();
      expect(session?.channelName).toBe('TestChannel');
    });

    it('should handle user leaving a channel (tracking enabled)', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const mockMember = {
        id: 'user123',
        displayName: 'TestUser',
        guild: { channels: { cache: { get: jest.fn().mockReturnValue(null) } } },
      } as unknown as GuildMember;
      const mockChannel = { id: 'channel123', name: 'TestChannel' } as unknown as VoiceChannel;

      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: null } as unknown as VoiceState,
        { member: mockMember, channel: mockChannel } as unknown as VoiceState,
      );
      expect(tracker.getActiveSession('user123')).not.toBeNull();

      (mockClient.users as any).fetch = jest.fn().mockResolvedValue({ username: 'TestUser', id: 'user123' });
      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: mockChannel } as unknown as VoiceState,
        { member: mockMember, channel: null } as unknown as VoiceState,
      );
      expect(tracker.getActiveSession('user123')).toBeNull();
    });

    it('should handle user switching channels', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const mockMember = {
        id: 'user123',
        displayName: 'TestUser',
        guild: { channels: { cache: { get: jest.fn().mockReturnValue(null) } } },
      } as unknown as GuildMember;
      const mockChannel1 = { id: 'channel1', name: 'Channel1' } as unknown as VoiceChannel;
      const mockChannel2 = { id: 'channel2', name: 'Channel2' } as unknown as VoiceChannel;
      (mockClient.users as any).fetch = jest.fn().mockResolvedValue({ username: 'TestUser', id: 'user123' });

      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: mockChannel1 } as unknown as VoiceState,
        { member: mockMember, channel: mockChannel2 } as unknown as VoiceState,
      );
      expect(tracker.getActiveSession('user123')?.channelName).toBe('Channel2');
    });

    it('should handle errors in voice state update gracefully', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockRejectedValue(new Error('Config error'));

      await expect(
        tracker.handleVoiceStateUpdate(
          { member: null, channel: null } as unknown as VoiceState,
          { member: null, channel: null } as unknown as VoiceState,
        )
      ).resolves.not.toThrow();
    });
  });

  describe('companion overlap & voice firsts (#570)', () => {
    // Builds a member whose guild channel cache returns a channel populated
    // with `presentIds` so startTracking can snapshot co-present users.
    function memberInChannel(
      id: string,
      channelId: string,
      channelName: string,
      presentIds: string[],
    ): GuildMember {
      const members = new Map(presentIds.map((p) => [p, { id: p }]));
      const channel = { id: channelId, name: channelName, members };
      return {
        id,
        displayName: id,
        guild: { channels: { cache: { get: jest.fn().mockReturnValue(channel) } } },
      } as unknown as GuildMember;
    }

    function gate(companionsEnabled: boolean) {
      return (key: string) =>
        Promise.resolve(
          key === 'voicetracking.enabled' ||
            (companionsEnabled && key === 'voicetracking.companions.enabled'),
        );
    }

    async function joinThenLeave(
      tracker: VoiceChannelTracker,
      member: GuildMember,
      channelId: string,
      channelName: string,
    ) {
      const channelState = { id: channelId, name: channelName } as unknown as VoiceChannel;
      // The global findOneAndUpdate mock accumulates calls across tests; clear
      // it so the assertion can read this scenario's session as calls[0].
      (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
      await tracker.handleVoiceStateUpdate(
        { member, channel: null } as unknown as VoiceState,
        { member, channel: channelState } as unknown as VoiceState,
      );
      await tracker.handleVoiceStateUpdate(
        { member, channel: channelState } as unknown as VoiceState,
        { member, channel: null } as unknown as VoiceState,
      );
    }

    it('omits companion/firsts fields when the feature is disabled', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockImplementation(gate(false));
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: 'u1', id: 'u1' });

      await joinThenLeave(
        tracker,
        memberInChannel('u1', 'c1', 'C1', ['other1']),
        'c1',
        'C1',
      );

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.companions).toBeUndefined();
      expect(pushed.wasFirst).toBeUndefined();
      expect(pushed.joinedExisting).toBeUndefined();
      // The legacy union set is still captured.
      expect(pushed.otherUsers).toEqual(['other1']);
    });

    it('captures companions, joinedExisting, and wasFirst=false when present at join', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockImplementation(gate(true));
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: 'u1', id: 'u1' });

      await joinThenLeave(
        tracker,
        memberInChannel('u1', 'c1', 'C1', ['other1']),
        'c1',
        'C1',
      );

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.wasFirst).toBe(false);
      expect(pushed.joinedExisting).toEqual(['other1']);
      expect(pushed.companions).toEqual([
        { userId: 'other1', seconds: expect.any(Number) },
      ]);
    });

    it('marks wasFirst=true when the channel was empty at join', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockImplementation(gate(true));
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: 'u1', id: 'u1' });

      await joinThenLeave(
        tracker,
        memberInChannel('u1', 'c1', 'C1', []),
        'c1',
        'C1',
      );

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.wasFirst).toBe(true);
      expect(pushed.joinedExisting).toEqual([]);
      expect(pushed.companions).toEqual([]);
    });
  });

  describe('getUserStats', () => {
    it('should return null when user not found', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);
      expect(await tracker.getUserStats('unknown-user')).toBeNull();
    });

    it('should return user stats for alltime period', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        userId: 'user123', username: 'TestUser', totalTime: 7200, lastSeen: new Date(), sessions: [],
      });

      const result = await tracker.getUserStats('user123', 'alltime');
      expect(result).not.toBeNull();
      expect(result?.userId).toBe('user123');
      expect(result?.totalTime).toBe(7200);
    });

    it('should return filtered stats for weekly period', async () => {
      const { tracker } = createTracker(mockClient);
      const recentDate = new Date();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        userId: 'user123', username: 'TestUser', totalTime: 7200, lastSeen: new Date(),
        sessions: [{ startTime: recentDate, endTime: recentDate, duration: 3600, channelId: 'ch1', channelName: 'Test' }],
      });

      const result = await tracker.getUserStats('user123', 'week');
      expect(result?.userId).toBe('user123');
    });

    it('should return filtered stats for monthly period', async () => {
      const { tracker } = createTracker(mockClient);
      const recentDate = new Date();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        userId: 'user123', username: 'TestUser', totalTime: 7200, lastSeen: new Date(),
        sessions: [{ startTime: recentDate, endTime: recentDate, duration: 3600, channelId: 'ch1', channelName: 'Test' }],
      });

      expect((await tracker.getUserStats('user123', 'month'))?.userId).toBe('user123');
    });

    it('should handle database errors gracefully', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await tracker.getUserStats('user123')).toBeNull();
    });
  });

  describe('getTopUsers', () => {
    it('should return top users for alltime period', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: 'user1', username: 'User1', totalTime: 10000 },
        { _id: 'user2', username: 'User2', totalTime: 8000 },
      ]);

      const result = await tracker.getTopUsers(10, 'alltime');
      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user1');
      expect(result[0].totalTime).toBe(10000);
    });

    it('should return top users for weekly period', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([{ _id: 'user1', username: 'User1', totalTime: 5000 }]);
      expect(await tracker.getTopUsers(10, 'week')).toHaveLength(1);
    });

    it('should return top users for monthly period', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([{ _id: 'user1', username: 'User1', totalTime: 5000 }]);
      expect(await tracker.getTopUsers(10, 'month')).toHaveLength(1);
    });

    it('should handle database errors and return empty array', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await tracker.getTopUsers()).toEqual([]);
    });

    it('reads the cap from the leaderboard_max_results config key', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(10, 'alltime');

      expect(mockConfigService.getNumber).toHaveBeenCalledWith(
        'voicetracking.stats.leaderboard_max_results',
        50,
      );
    });

    it('clamps a large requested limit to the configurable cap', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getNumber.mockResolvedValue(5);
      (VoiceChannelTracking.aggregate as jest.Mock).mockClear();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(1000, 'alltime');

      const pipeline = (VoiceChannelTracking.aggregate as jest.Mock).mock.calls[0][0];
      const limitStage = pipeline.find(
        (stage: Record<string, unknown>) => '$limit' in stage,
      );
      expect(limitStage).toEqual({ $limit: 5 });
    });

    it('keeps every row for the "all" sentinel (non-positive limit)', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getNumber.mockResolvedValue(5);
      (VoiceChannelTracking.aggregate as jest.Mock).mockClear();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(0, 'week');

      const pipeline = (VoiceChannelTracking.aggregate as jest.Mock).mock.calls[0][0];
      const limitStage = pipeline.find(
        (stage: Record<string, unknown>) => '$limit' in stage,
      );
      expect(limitStage).toBeUndefined();
    });
  });

  describe('getUserLastSeen', () => {
    it('should return null when user not found', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);
      expect(await tracker.getUserLastSeen('unknown-user')).toBeNull();
    });

    it('should return lastSeen date when user found', async () => {
      const { tracker } = createTracker(mockClient);
      const lastSeenDate = new Date('2024-01-01');
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({ lastSeen: lastSeenDate });
      expect(await tracker.getUserLastSeen('user123')).toEqual(lastSeenDate);
    });

    it('should handle database errors gracefully', async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockRejectedValue(new Error('DB error'));
      expect(await tracker.getUserLastSeen('user123')).toBeNull();
    });
  });

  describe('initialize', () => {
    it('should expose an initialize method', () => {
      const { tracker } = createTracker(mockClient);
      expect(typeof tracker.initialize).toBe('function');
    });
  });
});
