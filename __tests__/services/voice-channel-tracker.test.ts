import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { stubMongoGuard, stubTrackingOptOuts } from "../test-utils.js";
import type { Client, VoiceState, GuildMember, VoiceChannel } from "discord.js";

// Do NOT override the global mongoose mock from setup.ts — rely on it for stable jest.fn() instances.
// The global mock's model() returns a shared object so its methods can be reconfigured per-test.

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../src/services/achievements-service.js", () => ({
  AchievementsService: {
    getInstance: jest.fn(() => ({
      checkAndAwardAccolades: jest.fn().mockResolvedValue([]),
      checkAndAwardAchievements: jest.fn().mockResolvedValue(undefined),
      notifyUserOfAccolades: jest.fn().mockResolvedValue(undefined),
      announceMilestones: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

// Static imports — mocks are registered before these load (jest.mock is hoisted)
import { VoiceChannelTracker } from "../../src/services/voice-channel-tracker.js";
import { VoiceChannelTracking } from "../../src/models/voice-channel-tracking.js";
import { TrackingOptOutService } from "../../src/services/tracking-opt-out-service.js";

// Helper to create a configured tracker with injected mock config service
function createTracker(mockClient: Partial<Client>) {
  const tracker = VoiceChannelTracker.getInstance(mockClient as Client);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue("mongodb://localhost/test"),
    getBoolean: jest.fn().mockResolvedValue(false),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
    triggerReload: jest.fn().mockResolvedValue(undefined),
  };
  // Inject mock config service and stub the Mongo connection guard
  (tracker as never)["configService"] = mockConfigService;
  stubMongoGuard(tracker);

  return { tracker, mockConfigService };
}

describe("VoiceChannelTracker", () => {
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
    (VoiceChannelTracker as unknown as { instance: unknown }).instance =
      undefined;
    // Loaded and empty: the trackers fail closed on an unloaded cache.
    stubTrackingOptOuts();
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = VoiceChannelTracker.getInstance(mockClient as Client);
      const instance2 = VoiceChannelTracker.getInstance(mockClient as Client);
      expect(instance1).toBe(instance2);
    });

    it("should create an instance with a client", () => {
      expect(
        VoiceChannelTracker.getInstance(mockClient as Client),
      ).toBeDefined();
    });
  });

  describe("getActiveSession", () => {
    it("should return null for unknown user", () => {
      const { tracker } = createTracker(mockClient);
      expect(tracker.getActiveSession("unknown-user")).toBeNull();
    });
  });

  describe("handleVoiceStateUpdate", () => {
    it("should return early when voice tracking is disabled", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.handleVoiceStateUpdate(
        { member: null, channel: null } as unknown as VoiceState,
        { member: null, channel: null } as unknown as VoiceState,
      );
      expect(VoiceChannelTracking.findOne).not.toHaveBeenCalled();
    });

    it("should handle missing member gracefully when tracking enabled", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);

      await expect(
        tracker.handleVoiceStateUpdate(
          { member: null, channel: null } as unknown as VoiceState,
          { member: null, channel: null } as unknown as VoiceState,
        ),
      ).resolves.not.toThrow();
    });

    it("should handle user joining a channel (tracking enabled)", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const mockMember = {
        id: "user123",
        displayName: "TestUser",
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(null) } },
        },
      } as unknown as GuildMember;
      const mockChannel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;

      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: null } as unknown as VoiceState,
        { member: mockMember, channel: mockChannel } as unknown as VoiceState,
      );

      const session = tracker.getActiveSession("user123");
      expect(session).not.toBeNull();
      expect(session?.channelName).toBe("TestChannel");
    });

    it("should handle user leaving a channel (tracking enabled)", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const mockMember = {
        id: "user123",
        displayName: "TestUser",
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(null) } },
        },
      } as unknown as GuildMember;
      const mockChannel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;

      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: null } as unknown as VoiceState,
        { member: mockMember, channel: mockChannel } as unknown as VoiceState,
      );
      expect(tracker.getActiveSession("user123")).not.toBeNull();

      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "TestUser", id: "user123" });
      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: mockChannel } as unknown as VoiceState,
        { member: mockMember, channel: null } as unknown as VoiceState,
      );
      expect(tracker.getActiveSession("user123")).toBeNull();
    });

    it("should handle user switching channels", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const mockMember = {
        id: "user123",
        displayName: "TestUser",
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(null) } },
        },
      } as unknown as GuildMember;
      const mockChannel1 = {
        id: "channel1",
        name: "Channel1",
      } as unknown as VoiceChannel;
      const mockChannel2 = {
        id: "channel2",
        name: "Channel2",
      } as unknown as VoiceChannel;
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "TestUser", id: "user123" });

      await tracker.handleVoiceStateUpdate(
        { member: mockMember, channel: mockChannel1 } as unknown as VoiceState,
        { member: mockMember, channel: mockChannel2 } as unknown as VoiceState,
      );
      expect(tracker.getActiveSession("user123")?.channelName).toBe("Channel2");
    });

    it("should handle errors in voice state update gracefully", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockRejectedValue(new Error("Config error"));

      await expect(
        tracker.handleVoiceStateUpdate(
          { member: null, channel: null } as unknown as VoiceState,
          { member: null, channel: null } as unknown as VoiceState,
        ),
      ).resolves.not.toThrow();
    });
  });

  // #914: a member sitting in a voice channel when their data is purged
  // must not have the row resurrected by `endTracking`'s `upsert: true` —
  // which would carry back `totalTime` for the hours before the purge and
  // feed it to the accolade check.
  describe("forgetActiveSession (#914)", () => {
    function memberIn(id: string): GuildMember {
      return {
        id,
        displayName: id,
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(null) } },
        },
      } as unknown as GuildMember;
    }

    async function joinChannel(
      tracker: VoiceChannelTracker,
      member: GuildMember,
      channel: VoiceChannel,
    ): Promise<void> {
      await tracker.handleVoiceStateUpdate(
        { member, channel: null } as unknown as VoiceState,
        { member, channel } as unknown as VoiceState,
      );
    }

    async function leaveChannel(
      tracker: VoiceChannelTracker,
      member: GuildMember,
      channel: VoiceChannel,
    ): Promise<void> {
      await tracker.handleVoiceStateUpdate(
        { member, channel } as unknown as VoiceState,
        { member, channel: null } as unknown as VoiceState,
      );
    }

    it("stops the disconnect handler from writing a row for an in-flight session", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const channel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;

      await joinChannel(tracker, member, channel);
      expect(tracker.getActiveSession("user123")).not.toBeNull();

      const forgotten = await tracker.forgetActiveSession("user123");
      expect(forgotten).toEqual({
        discarded: true,
        drained: false,
        timedOut: false,
      });
      expect(tracker.getActiveSession("user123")).toBeNull();

      (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
      await leaveChannel(tracker, member, channel);

      // No session left to close, so nothing is persisted — and in
      // particular no `upsert` recreates the purged document.
      expect(VoiceChannelTracking.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("is a no-op for a member with no active session", async () => {
      const { tracker } = createTracker(mockClient);
      await expect(tracker.forgetActiveSession("nobody")).resolves.toEqual({
        discarded: false,
        drained: false,
        timedOut: false,
      });
      expect(tracker.getActiveSession("nobody")).toBeNull();
    });

    it("waits for a persist that already read its session (#916)", async () => {
      // Evicting the maps cannot call back an `endTracking` that is already
      // past its `activeSessions.get`: its `upsert: true` write is still to
      // come, and if it lands after the purge's delete the row — and the
      // whole session's `totalTime` — is resurrected. So the eviction has to
      // wait that write out rather than race it.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const channel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;
      await joinChannel(tracker, member, channel);

      // Hold the persist open so the eviction lands while it is in flight.
      let releaseWrite: () => void = () => {};
      const writeStarted = new Promise<void>((startResolve) => {
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockImplementation(
          () => {
            startResolve();
            return new Promise((writeResolve) => {
              releaseWrite = () => writeResolve({});
            });
          },
        );
      });

      const disconnect = leaveChannel(tracker, member, channel);
      await writeStarted;

      let forgetSettled = false;
      const forgetting = tracker
        .forgetActiveSession("user123")
        .then((result) => {
          forgetSettled = true;
          return result;
        });

      // Still blocked: the write has not finished, so neither has the purge's
      // permission to delete the row.
      await Promise.resolve();
      expect(forgetSettled).toBe(false);

      releaseWrite();
      await disconnect;

      await expect(forgetting).resolves.toEqual({
        // Both at once, which is exactly the dangerous shape: the map still
        // held the session (`endTracking` only clears it after the write),
        // so eviction alone would have looked like a clean discard while the
        // write it could not call back was still on its way.
        discarded: true,
        drained: true,
        timedOut: false,
      });
      expect(VoiceChannelTracking.findOneAndUpdate).toHaveBeenCalled();
    });

    it("drains every overlapping persist, not just the newest (#916)", async () => {
      // `voiceStateUpdate` handlers are async and the emitter does not
      // serialise them, so a switch followed closely by a disconnect can
      // leave two `endTracking` calls running for one member. Keeping only
      // the latest meant the newer one finishing first cleared the entry
      // while the older write was still pending — and the drain sailed
      // straight past it, letting that write recreate the purged row.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const channel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;

      // Each persist hangs until its own release is called.
      const releases: Array<() => void> = [];
      (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockImplementation(
        () => new Promise((resolve) => releases.push(() => resolve({}))),
      );

      /** Yield until `count` persists have reached their write. */
      async function writesStarted(count: number): Promise<void> {
        for (let tick = 0; tick < 100 && releases.length < count; tick++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(releases.length).toBe(count);
      }

      // Two overlapping persists for the same member.
      await joinChannel(tracker, member, channel);
      const first = leaveChannel(tracker, member, channel);
      await writesStarted(1);
      await joinChannel(tracker, member, channel);
      const second = leaveChannel(tracker, member, channel);
      await writesStarted(2);

      // The newer one finishes first — the case that used to clear the entry.
      releases[1]();
      await second;

      let forgetSettled = false;
      const forgetting = tracker
        .forgetActiveSession("user123")
        .then((result) => {
          forgetSettled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(forgetSettled).toBe(false);

      releases[0]();
      await first;

      await expect(forgetting).resolves.toMatchObject({ drained: true });
    });

    it("gives up on a persist that never settles, rather than hanging (#916)", async () => {
      // `endTracking` keeps going past its Mongo write — Discord fetches,
      // accolade checks — so one stalled call must not take the rest of the
      // purge with it. The wait is bounded and the step is reported as
      // incomplete instead.
      jest.useFakeTimers();
      try {
        const { tracker, mockConfigService } = createTracker(mockClient);
        mockConfigService.getBoolean.mockResolvedValue(true);
        mockConfigService.get.mockResolvedValue(null);
        (mockClient.users as any).fetch = jest
          .fn()
          .mockResolvedValue({ username: "user123", id: "user123" });

        const member = memberIn("user123");
        const channel = {
          id: "channel123",
          name: "TestChannel",
        } as unknown as VoiceChannel;

        // This persist never resolves.
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockImplementation(
          () => new Promise(() => {}),
        );

        await joinChannel(tracker, member, channel);
        void leaveChannel(tracker, member, channel);
        // Let the disconnect reach its (hanging) write.
        await jest.advanceTimersByTimeAsync(0);

        const forgetting = tracker.forgetActiveSession("user123");
        // Nothing settles on its own; only the timeout releases the wait.
        await jest.advanceTimersByTimeAsync(20_000);

        await expect(forgetting).resolves.toMatchObject({
          drained: true,
          timedOut: true,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it("does not restart tracking for a switch interrupted by a purge (#916)", async () => {
      // A channel switch awaits `endTracking` and then calls `startTracking`.
      // Without a generation check the restart lands after the eviction, and
      // the next disconnect upserts the row the purge just deleted.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const oldChannel = {
        id: "channel-a",
        name: "A",
      } as unknown as VoiceChannel;
      const newChannel = {
        id: "channel-b",
        name: "B",
      } as unknown as VoiceChannel;

      await joinChannel(tracker, member, oldChannel);

      // Hold the switch inside `endTracking`, evict, then release it.
      let releaseWrite: () => void = () => {};
      const writeStarted = new Promise<void>((started) => {
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockImplementation(
          () =>
            new Promise((resolve) => {
              releaseWrite = () => resolve({});
              started();
            }),
        );
      });

      const switching = tracker.handleVoiceStateUpdate(
        { member, channel: oldChannel } as unknown as VoiceState,
        { member, channel: newChannel } as unknown as VoiceState,
      );
      await writeStarted;

      const forgetting = tracker.forgetActiveSession("user123");
      releaseWrite();
      await forgetting;
      await switching;

      // The switch gave up instead of re-opening a session the purge closed.
      expect(tracker.getActiveSession("user123")).toBeNull();
    });

    it("keeps a rejoin that lands while the old persist is still running (#916)", async () => {
      // `endTracking` captures its session at the top and only writes many
      // awaits later. Clearing the per-user maps at the end of that call used
      // to wipe whatever was there — including a session started by a rejoin
      // in the meantime, whose own disconnect would then record nothing.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const first = { id: "channel-a", name: "A" } as unknown as VoiceChannel;
      const second = { id: "channel-b", name: "B" } as unknown as VoiceChannel;

      await joinChannel(tracker, member, first);

      // Hold the disconnect's persist open, rejoin, then release it.
      let releaseWrite: () => void = () => {};
      const writeStarted = new Promise<void>((started) => {
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockImplementation(
          () =>
            new Promise((resolve) => {
              releaseWrite = () => resolve({});
              started();
            }),
        );
      });

      const leaving = leaveChannel(tracker, member, first);
      await writeStarted;
      await joinChannel(tracker, member, second);
      releaseWrite();
      await leaving;

      // The rejoin survived the old call's cleanup.
      expect(tracker.getActiveSession("user123")?.channelName).toBe("B");
    });

    it("persists a session once even when two handlers overlap (#916)", async () => {
      // Discord does not await its handlers, so a switch still waiting on
      // its write and a disconnect arriving behind it both read the same
      // session — and both would `$inc totalTime` and `$push` it.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const channel = { id: "channel-a", name: "A" } as unknown as VoiceChannel;
      await joinChannel(tracker, member, channel);

      let releaseWrite: () => void = () => {};
      const writeStarted = new Promise<void>((started) => {
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockImplementation(
          () =>
            new Promise((resolve) => {
              releaseWrite = () => resolve({});
              started();
            }),
        );
      });
      (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();

      const first = leaveChannel(tracker, member, channel);
      await writeStarted;
      const second = leaveChannel(tracker, member, channel);
      releaseWrite();
      await Promise.all([first, second]);

      expect(
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock.calls.length,
      ).toBe(1);
    });

    it("hands the session's bookkeeping back when the persist fails (#916)", async () => {
      // `activeSessions` is deliberately kept on a failed write so the next
      // disconnect retries it — and the retry has to see the companions and
      // encountered users the failed attempt had claimed, not an empty
      // session.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const member = memberIn("user123");
      const channel = { id: "channel-a", name: "A" } as unknown as VoiceChannel;
      await joinChannel(tracker, member, channel);
      await joinChannel(tracker, memberIn("user456"), channel);

      (VoiceChannelTracking.findOneAndUpdate as jest.Mock)
        .mockRejectedValueOnce(new Error("write conflict"))
        .mockResolvedValue({});

      await leaveChannel(tracker, member, channel);
      // The session survived the failure, as before.
      expect(tracker.getActiveSession("user123")).not.toBeNull();

      (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
      await leaveChannel(tracker, member, channel);

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.otherUsers).toEqual(["user456"]);
    });

    it("does not start tracking for a join that predates the purge (#916)", async () => {
      // The handler yields on the enablement lookup before it ever reaches
      // `startTracking`. Reading the generation after that await would hand
      // the resumed handler the *post*-purge value, and it would install a
      // session for an event from before the erasure.
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.get.mockResolvedValue(null);

      // Park only the first lookup — the one the handler hits before it can
      // reach `startTracking`; later ones resolve normally.
      let allowEnablement: () => void = () => {};
      let parked = false;
      const enablementAsked = new Promise<void>((asked) => {
        mockConfigService.getBoolean.mockImplementation(() => {
          if (parked) return Promise.resolve(true);
          parked = true;
          return new Promise((resolve) => {
            allowEnablement = (): void => resolve(true);
            asked();
          });
        });
      });

      const member = memberIn("user123");
      const channel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;

      const joining = tracker.handleVoiceStateUpdate(
        { member, channel: null } as unknown as VoiceState,
        { member, channel } as unknown as VoiceState,
      );
      await enablementAsked;

      // The purge lands while the handler is parked on the config read.
      await tracker.forgetActiveSession("user123");
      allowEnablement();
      await joining;

      expect(tracker.getActiveSession("user123")).toBeNull();
    });

    it("leaves other members' in-flight sessions alone", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);

      const channel = {
        id: "channel123",
        name: "TestChannel",
      } as unknown as VoiceChannel;
      await joinChannel(tracker, memberIn("user123"), channel);
      await joinChannel(tracker, memberIn("user456"), channel);

      tracker.forgetActiveSession("user123");

      expect(tracker.getActiveSession("user123")).toBeNull();
      expect(tracker.getActiveSession("user456")?.channelName).toBe(
        "TestChannel",
      );
    });

    it("drops the companion state so a later session starts clean", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      // Companions on, so `endTracking` reads the companion maps.
      mockConfigService.getBoolean.mockResolvedValue(true);
      mockConfigService.get.mockResolvedValue(null);
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "user123", id: "user123" });

      const members = new Map([["user456", { id: "user456" }]]);
      const populated = {
        id: "channel123",
        name: "TestChannel",
        members,
      } as unknown as VoiceChannel;
      const member = {
        id: "user123",
        displayName: "user123",
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(populated) } },
        },
      } as unknown as GuildMember;

      await joinChannel(tracker, member, populated);
      tracker.forgetActiveSession("user123");

      // Re-join and disconnect properly: the persisted session must carry
      // only the new session's companions, never the forgotten one's.
      (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
      const empty = {
        id: "channel789",
        name: "OtherChannel",
        members: new Map(),
      } as unknown as VoiceChannel;
      const soloMember = {
        id: "user123",
        displayName: "user123",
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(empty) } },
        },
      } as unknown as GuildMember;

      await joinChannel(tracker, soloMember, empty);
      await leaveChannel(tracker, soloMember, empty);

      expect(VoiceChannelTracking.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [, update] = (VoiceChannelTracking.findOneAndUpdate as jest.Mock)
        .mock.calls[0] as [unknown, { $push: { sessions: any } }];
      expect(update.$push.sessions.otherUsers).toEqual([]);
      expect(update.$push.sessions.companions).toEqual([]);
      expect(update.$push.sessions.wasFirst).toBe(true);
    });
  });

  describe("companion overlap & voice firsts (#570)", () => {
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
        guild: {
          channels: { cache: { get: jest.fn().mockReturnValue(channel) } },
        },
      } as unknown as GuildMember;
    }

    function gate(companionsEnabled: boolean) {
      return (key: string) =>
        Promise.resolve(
          key === "voicetracking.enabled" ||
            (companionsEnabled && key === "voicetracking.companions.enabled"),
        );
    }

    async function joinThenLeave(
      tracker: VoiceChannelTracker,
      member: GuildMember,
      channelId: string,
      channelName: string,
    ) {
      const channelState = {
        id: channelId,
        name: channelName,
      } as unknown as VoiceChannel;
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

    it("omits companion/firsts fields when the feature is disabled", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockImplementation(gate(false));
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "u1", id: "u1" });

      await joinThenLeave(
        tracker,
        memberInChannel("u1", "c1", "C1", ["other1"]),
        "c1",
        "C1",
      );

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.companions).toBeUndefined();
      expect(pushed.wasFirst).toBeUndefined();
      expect(pushed.joinedExisting).toBeUndefined();
      // The legacy union set is still captured.
      expect(pushed.otherUsers).toEqual(["other1"]);
    });

    it("captures companions, joinedExisting, and wasFirst=false when present at join", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockImplementation(gate(true));
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "u1", id: "u1" });

      await joinThenLeave(
        tracker,
        memberInChannel("u1", "c1", "C1", ["other1"]),
        "c1",
        "C1",
      );

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.wasFirst).toBe(false);
      expect(pushed.joinedExisting).toEqual(["other1"]);
      expect(pushed.companions).toEqual([
        { userId: "other1", seconds: expect.any(Number) },
      ]);
    });

    it("marks wasFirst=true when the channel was empty at join", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getBoolean.mockImplementation(gate(true));
      (mockClient.users as any).fetch = jest
        .fn()
        .mockResolvedValue({ username: "u1", id: "u1" });

      await joinThenLeave(
        tracker,
        memberInChannel("u1", "c1", "C1", []),
        "c1",
        "C1",
      );

      const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
        .calls[0][1].$push.sessions;
      expect(pushed.wasFirst).toBe(true);
      expect(pushed.joinedExisting).toEqual([]);
      expect(pushed.companions).toEqual([]);
    });

    describe("tracking opt-out (#918)", () => {
      function inGuild(member: GuildMember, guildId = "g1"): GuildMember {
        (member.guild as unknown as { id: string }).id = guildId;
        return member;
      }

      function companionsOn(mockConfigService: {
        getBoolean: jest.Mock;
      }): void {
        mockConfigService.getBoolean.mockImplementation(gate(true) as never);
        (mockClient.users as any).fetch = jest
          .fn()
          .mockResolvedValue({ username: "u1", id: "u1" });
      }

      it("starts no session for an opted-out member, so nothing persists", async () => {
        stubTrackingOptOuts([["u1", "g1"]]);
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(memberInChannel("u1", "c1", "C1", []));

        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          {
            member,
            channel: { id: "c1", name: "C1" },
          } as unknown as VoiceState,
        );
        expect(tracker.getActiveSession("u1")).toBeNull();

        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          {
            member,
            channel: { id: "c1", name: "C1" },
          } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );
        expect(VoiceChannelTracking.findOneAndUpdate).not.toHaveBeenCalled();
      });

      it("discards a session when the member opts out mid-session", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(memberInChannel("u1", "c1", "C1", ["other1"]));
        const channel = { id: "c1", name: "C1" };

        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );
        expect(tracker.getActiveSession("u1")).not.toBeNull();

        // Opt out while still in the channel.
        stubTrackingOptOuts([["u1", "g1"]]);
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );

        expect(VoiceChannelTracking.findOneAndUpdate).not.toHaveBeenCalled();
        expect(tracker.getActiveSession("u1")).toBeNull();
      });

      it("registers its opt-out hook at construction, before initialize()", () => {
        stubTrackingOptOuts();
        createTracker(mockClient);
        const hooks = (
          TrackingOptOutService.getInstance() as unknown as {
            optOutHooks: unknown[];
          }
        ).optOutHooks;
        expect(hooks).toHaveLength(1);
      });

      it("evicts a live session through the opt-out hook, so opting straight back in cannot persist it", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        await tracker.initialize();
        const member = inGuild(memberInChannel("u1", "c1", "C1", []));
        const channel = { id: "c1", name: "C1" };

        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );
        expect(tracker.getActiveSession("u1")).not.toBeNull();

        // What `optOut` runs once the cache knows.
        const hooks = (
          TrackingOptOutService.getInstance() as unknown as {
            optOutHooks: Array<(u: string, g: string) => Promise<unknown>>;
          }
        ).optOutHooks;
        expect(hooks).toHaveLength(1);
        await hooks[0]("u1", "g1");
        expect(tracker.getActiveSession("u1")).toBeNull();

        // Opted back in (the cache is empty again) — the disconnect still
        // finds nothing to write.
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );
        expect(VoiceChannelTracking.findOneAndUpdate).not.toHaveBeenCalled();
      });

      it("drops the session when the opt-out lands while the persist is fetching the user", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(memberInChannel("u1", "c1", "C1", []));
        const channel = { id: "c1", name: "C1" };
        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );

        // The opt-out lands during the user fetch, after the first check.
        (mockClient.users as any).fetch = jest.fn(async () => {
          (
            TrackingOptOutService.getInstance() as unknown as {
              optedOut: Set<string>;
            }
          ).optedOut.add("g1:u1");
          return { username: "u1", id: "u1" };
        });
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );

        expect(VoiceChannelTracking.findOneAndUpdate).not.toHaveBeenCalled();
        expect(tracker.getActiveSession("u1")).toBeNull();
      });

      it("purges a companion's live co-presence on opt-out, so opting back in cannot leak it", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        await tracker.initialize();
        const member = inGuild(
          memberInChannel("u1", "c1", "C1", ["other1", "later"]),
        );
        const channel = { id: "c1", name: "C1" };
        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );

        const service = TrackingOptOutService.getInstance() as unknown as {
          optedOut: Set<string>;
          optOutHooks: Array<(u: string, g: string) => Promise<unknown>>;
        };
        // "later" opts out (hook runs) and straight back in.
        service.optedOut.add("g1:later");
        await service.optOutHooks[0]("later", "g1");
        service.optedOut.delete("g1:later");

        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );

        const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
          .calls[0][1].$push.sessions;
        expect(pushed.otherUsers).toEqual(["other1"]);
        expect(pushed.joinedExisting).toEqual(["other1"]);
        expect(
          (pushed.companions as Array<{ userId: string }>).map((c) => c.userId),
        ).toEqual(["other1"]);
      });

      it("drops a companion again after a failed persist hands its state back", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(
          memberInChannel("u1", "c1", "C1", ["other1", "later"]),
        );
        const channel = { id: "c1", name: "C1" };
        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );

        // u1's persist is slow and then fails, so its claimed co-presence
        // (still naming "later") is handed back to the live maps.
        let failPersist: () => void = () => undefined;
        (
          VoiceChannelTracking.findOneAndUpdate as jest.Mock
        ).mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              failPersist = () => reject(new Error("mongo blip"));
            }),
        );
        const leaving = tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );
        for (let i = 0; i < 10; i++) await Promise.resolve();

        const service = TrackingOptOutService.getInstance() as unknown as {
          optedOut: Set<string>;
          optOutHooks: Array<(u: string, g: string) => Promise<unknown>>;
        };
        service.optedOut.add("g1:later");
        const hookDone = service.optOutHooks[0]("later", "g1");
        await new Promise((r) => setTimeout(r, 0));
        failPersist();
        await leaving;
        await expect(hookDone).resolves.toBe(true);

        const maps = tracker as unknown as {
          encounteredUsers: Map<string, Set<string>>;
          companionSince: Map<string, Map<string, number>>;
        };
        expect(maps.encounteredUsers.get("u1")?.has("later")).toBe(false);
        expect(maps.companionSince.get("u1")?.has("later")).toBe(false);
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockResolvedValue(
          {},
        );
      });

      /** Opt `userId` out and straight back in, as the service does. */
      function optOutAndBackIn(userId: string): void {
        const service = TrackingOptOutService.getInstance() as unknown as {
          optedOut: Set<string>;
          engageBarrier: (key: string) => void;
        };
        service.optedOut.add(`g1:${userId}`);
        service.engageBarrier(`g1:${userId}`);
        service.optedOut.delete(`g1:${userId}`);
        service.engageBarrier(`g1:${userId}`);
      }

      it("starts no session for a join suspended across an opt-out and back in", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        const gateFn = gate(true);
        let fired = false;
        mockConfigService.getBoolean.mockImplementation((async (
          key: string,
        ) => {
          if (!fired && key === "voicetracking.enabled") {
            fired = true;
            optOutAndBackIn("u1");
          }
          return gateFn(key);
        }) as never);
        const member = inGuild(memberInChannel("u1", "c1", "C1", []));

        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          {
            member,
            channel: { id: "c1", name: "C1" },
          } as unknown as VoiceState,
        );
        expect(tracker.getActiveSession("u1")).toBeNull();
      });

      it("rejects a ticket the caller took before an opt-out and back in", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(memberInChannel("u1", "c1", "C1", []));

        // As index.ts does: ticket first, then the channel manager's await.
        const ticket = TrackingOptOutService.getInstance().admission();
        optOutAndBackIn("u1");
        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          {
            member,
            channel: { id: "c1", name: "C1" },
          } as unknown as VoiceState,
          ticket,
        );
        expect(tracker.getActiveSession("u1")).toBeNull();
      });

      it("adds no co-presence for a join suspended across the joiner's opt-out and back in", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const owner = inGuild(memberInChannel("u1", "c1", "C1", []));
        const channel = { id: "c1", name: "C1" };
        await tracker.handleVoiceStateUpdate(
          { member: owner, channel: null } as unknown as VoiceState,
          { member: owner, channel } as unknown as VoiceState,
        );

        const ticket = TrackingOptOutService.getInstance().admission();
        optOutAndBackIn("later");
        const joiner = inGuild(memberInChannel("later", "c1", "C1", ["u1"]));
        await tracker.handleVoiceStateUpdate(
          { member: joiner, channel: null } as unknown as VoiceState,
          { member: joiner, channel } as unknown as VoiceState,
          ticket,
        );

        const maps = tracker as unknown as {
          encounteredUsers: Map<string, Set<string>>;
          companionSince: Map<string, Map<string, number>>;
        };
        expect(maps.encounteredUsers.get("u1")?.has("later")).toBe(false);
        expect(maps.companionSince.get("u1")?.has("later")).toBe(false);
        expect(tracker.getActiveSession("later")).toBeNull();
      });

      it("records no co-presence for a member who joins while opted out", async () => {
        stubTrackingOptOuts([["hidden", "g1"]]);
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(memberInChannel("u1", "c1", "C1", []));
        const channel = { id: "c1", name: "C1" };
        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );

        const hidden = inGuild(memberInChannel("hidden", "c1", "C1", ["u1"]));
        await tracker.handleVoiceStateUpdate(
          { member: hidden, channel: null } as unknown as VoiceState,
          { member: hidden, channel } as unknown as VoiceState,
        );
        // Opted back in before u1 leaves: nothing from the opted-out
        // period may surface.
        stubTrackingOptOuts();
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );

        const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
          .calls[0][1].$push.sessions;
        expect(pushed.otherUsers).toEqual([]);
        expect(pushed.companions).toEqual([]);
      });

      it("leaves an opted-out member out of another member's session", async () => {
        stubTrackingOptOuts([["hidden", "g1"]]);
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);

        await joinThenLeave(
          tracker,
          inGuild(memberInChannel("u1", "c1", "C1", ["other1", "hidden"])),
          "c1",
          "C1",
        );

        const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
          .calls[0][1].$push.sessions;
        expect(pushed.otherUsers).toEqual(["other1"]);
        expect(pushed.joinedExisting).toEqual(["other1"]);
        expect(pushed.companions).toEqual([
          { userId: "other1", seconds: expect.any(Number) },
        ]);
      });

      it("drops a companion who opts out while co-present", async () => {
        stubTrackingOptOuts();
        const { tracker, mockConfigService } = createTracker(mockClient);
        companionsOn(mockConfigService);
        const member = inGuild(
          memberInChannel("u1", "c1", "C1", ["other1", "later"]),
        );
        const channel = { id: "c1", name: "C1" };

        await tracker.handleVoiceStateUpdate(
          { member, channel: null } as unknown as VoiceState,
          { member, channel } as unknown as VoiceState,
        );
        stubTrackingOptOuts([["later", "g1"]]);
        (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mockClear();
        await tracker.handleVoiceStateUpdate(
          { member, channel } as unknown as VoiceState,
          { member, channel: null } as unknown as VoiceState,
        );

        const pushed = (VoiceChannelTracking.findOneAndUpdate as jest.Mock).mock
          .calls[0][1].$push.sessions;
        expect(pushed.otherUsers).toEqual(["other1"]);
        expect(pushed.joinedExisting).toEqual(["other1"]);
        expect(
          (pushed.companions as Array<{ userId: string }>).map((c) => c.userId),
        ).toEqual(["other1"]);
      });
    });
  });

  describe("getUserStats", () => {
    it("should return null when user not found", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);
      expect(await tracker.getUserStats("unknown-user")).toBeNull();
    });

    it("should return user stats for alltime period", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        userId: "user123",
        username: "TestUser",
        totalTime: 7200,
        lastSeen: new Date(),
        sessions: [],
      });

      const result = await tracker.getUserStats("user123", "alltime");
      expect(result).not.toBeNull();
      expect(result?.userId).toBe("user123");
      expect(result?.totalTime).toBe(7200);
    });

    it("should return filtered stats for weekly period", async () => {
      const { tracker } = createTracker(mockClient);
      const recentDate = new Date();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        userId: "user123",
        username: "TestUser",
        totalTime: 7200,
        lastSeen: new Date(),
        sessions: [
          {
            startTime: recentDate,
            endTime: recentDate,
            duration: 3600,
            channelId: "ch1",
            channelName: "Test",
          },
        ],
      });

      const result = await tracker.getUserStats("user123", "week");
      expect(result?.userId).toBe("user123");
    });

    it("should return filtered stats for monthly period", async () => {
      const { tracker } = createTracker(mockClient);
      const recentDate = new Date();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        userId: "user123",
        username: "TestUser",
        totalTime: 7200,
        lastSeen: new Date(),
        sessions: [
          {
            startTime: recentDate,
            endTime: recentDate,
            duration: 3600,
            channelId: "ch1",
            channelName: "Test",
          },
        ],
      });

      expect((await tracker.getUserStats("user123", "month"))?.userId).toBe(
        "user123",
      );
    });

    it("should handle database errors gracefully", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockRejectedValue(
        new Error("DB error"),
      );
      expect(await tracker.getUserStats("user123")).toBeNull();
    });
  });

  describe("getTopUsers", () => {
    it("should return top users for alltime period", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: "user1", username: "User1", totalTime: 10000 },
        { _id: "user2", username: "User2", totalTime: 8000 },
      ]);

      const result = await tracker.getTopUsers(10, "alltime");
      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe("user1");
      expect(result[0].totalTime).toBe(10000);
    });

    it("should return top users for weekly period", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: "user1", username: "User1", totalTime: 5000 },
      ]);
      expect(await tracker.getTopUsers(10, "week")).toHaveLength(1);
    });

    it("should return top users for monthly period", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: "user1", username: "User1", totalTime: 5000 },
      ]);
      expect(await tracker.getTopUsers(10, "month")).toHaveLength(1);
    });

    it("should handle database errors and return empty array", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockRejectedValue(
        new Error("DB error"),
      );
      expect(await tracker.getTopUsers()).toEqual([]);
    });

    it("reads the cap from the leaderboard_max_results config key", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(10, "alltime");

      expect(mockConfigService.getNumber).toHaveBeenCalledWith(
        "voicetracking.stats.leaderboard_max_results",
        50,
      );
    });

    it("clamps a large requested limit to the configurable cap", async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getNumber.mockResolvedValue(5);
      (VoiceChannelTracking.aggregate as jest.Mock).mockClear();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(1000, "alltime");

      const pipeline = (VoiceChannelTracking.aggregate as jest.Mock).mock
        .calls[0][0];
      const limitStage = pipeline.find(
        (stage: Record<string, unknown>) => "$limit" in stage,
      );
      expect(limitStage).toEqual({ $limit: 5 });
    });

    // `$unwind` before `$match` flattened every session of every user on each
    // call and could not use an index; the window filter must come first so
    // the multikey `sessions.startTime` index narrows the documents (#842).
    it.each(["week", "month"] as const)(
      "%s: matches on sessions.startTime before unwinding, then re-filters",
      async (period) => {
        // Freeze the clock so the expected window start is exact rather
        // than a wall-clock approximation that could drift on a slow runner.
        const now = new Date("2026-03-15T12:00:00Z");
        jest.useFakeTimers({ now });
        try {
          const { tracker } = createTracker(mockClient);
          (VoiceChannelTracking.aggregate as jest.Mock).mockClear();
          (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

          await tracker.getTopUsers(10, period);

          const pipeline = (VoiceChannelTracking.aggregate as jest.Mock).mock
            .calls[0][0] as Array<Record<string, unknown>>;
          const stageNames = pipeline.map((stage) => Object.keys(stage)[0]);
          expect(stageNames).toEqual([
            "$match",
            "$unwind",
            "$match",
            "$group",
            "$sort",
            "$limit",
          ]);

          const windowDays = period === "week" ? 7 : 30;
          const expectedStart = new Date(
            now.getTime() - windowDays * 24 * 60 * 60 * 1000,
          );
          expect(pipeline[0]).toEqual({
            $match: { "sessions.startTime": { $gte: expectedStart } },
          });
          expect(pipeline[1]).toEqual({ $unwind: "$sessions" });
          // Both stages use the same window: the pre-unwind match selects
          // users with any qualifying session; the post-unwind one drops the
          // rest of that user's sessions.
          expect(pipeline[2]).toEqual(pipeline[0]);
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it("alltime: does not unwind sessions at all", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.aggregate as jest.Mock).mockClear();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(10, "alltime");

      const pipeline = (VoiceChannelTracking.aggregate as jest.Mock).mock
        .calls[0][0] as Array<Record<string, unknown>>;
      expect(pipeline.some((stage) => "$unwind" in stage)).toBe(false);
    });

    it('keeps every row for the "all" sentinel (non-positive limit)', async () => {
      const { tracker, mockConfigService } = createTracker(mockClient);
      mockConfigService.getNumber.mockResolvedValue(5);
      (VoiceChannelTracking.aggregate as jest.Mock).mockClear();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);

      await tracker.getTopUsers(0, "week");

      const pipeline = (VoiceChannelTracking.aggregate as jest.Mock).mock
        .calls[0][0];
      const limitStage = pipeline.find(
        (stage: Record<string, unknown>) => "$limit" in stage,
      );
      expect(limitStage).toBeUndefined();
    });
  });

  describe("getUserLastSeen", () => {
    it("should return null when user not found", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);
      expect(await tracker.getUserLastSeen("unknown-user")).toBeNull();
    });

    it("should return lastSeen date when user found", async () => {
      const { tracker } = createTracker(mockClient);
      const lastSeenDate = new Date("2024-01-01");
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        lastSeen: lastSeenDate,
      });
      expect(await tracker.getUserLastSeen("user123")).toEqual(lastSeenDate);
    });

    it("should handle database errors gracefully", async () => {
      const { tracker } = createTracker(mockClient);
      (VoiceChannelTracking.findOne as jest.Mock).mockRejectedValue(
        new Error("DB error"),
      );
      expect(await tracker.getUserLastSeen("user123")).toBeNull();
    });
  });

  describe("initialize", () => {
    it("should expose an initialize method", () => {
      const { tracker } = createTracker(mockClient);
      expect(typeof tracker.initialize).toBe("function");
    });
  });
});
