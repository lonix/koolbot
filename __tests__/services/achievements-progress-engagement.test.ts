import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

// Mirrors the proven mocking pattern in achievements-service.test.ts: mock the
// logger, the UserAchievements model (callable constructor + statics) and the
// quote service, and rely on the global mongoose mock (setup.ts) for the other
// models. NB: in this ESM setup every mongoose model shares ONE mocked object,
// so VoiceChannelTracking/MessageActivityTracking/etc. all share the same
// `findOne`/`aggregate` — tests craft a single return object that satisfies
// whichever reader runs.

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../src/models/user-achievements.js", () => ({
  UserAchievements: Object.assign(
    jest.fn().mockImplementation(() => ({
      accolades: [],
      achievements: [],
      statistics: { totalAccolades: 0, totalAchievements: 0 },
      save: jest.fn().mockResolvedValue(undefined),
    })),
    { findOne: jest.fn(), find: jest.fn() },
  ),
}));

jest.mock("../../src/services/quote-service.js", () => ({
  quoteService: {
    getQuotesAuthoredByUser: jest.fn().mockResolvedValue(0),
    getQuotesAddedByUser: jest.fn().mockResolvedValue(0),
    getMostLikedQuoteByAuthor: jest.fn().mockResolvedValue(null),
  },
}));

import { AchievementsService } from "../../src/services/achievements-service.js";
import { UserAchievements } from "../../src/models/user-achievements.js";
import { VoiceChannelTracking } from "../../src/models/voice-channel-tracking.js";

// Start of the current ISO week — Monday 00:00 UTC. Mirrors the service so
// crafted sessions land deterministically inside "this week".
function startOfWeekUtc(now = new Date()): Date {
  const dow = now.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - back,
      0,
      0,
      0,
      0,
    ),
  );
}

// Build a service with an injected config service. `flags` overrides specific
// boolean keys; everything else defaults to true. `guildId` controls the
// bootstrap GUILD_ID used by the per-guild engagement lookups.
function createService(
  flags: Record<string, boolean> = {},
  guildId = "",
): AchievementsService {
  const service = AchievementsService.getInstance({} as Client);
  const mockConfigService = {
    getString: jest.fn(async (key: unknown) =>
      key === "GUILD_ID" ? guildId : "mongodb://localhost/test",
    ),
    getBoolean: jest.fn(async (key: unknown) =>
      typeof key === "string" && key in flags ? flags[key] : true,
    ),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
    triggerReload: jest.fn().mockResolvedValue(undefined),
  };
  (service as never)["configService"] = mockConfigService;
  (service as never)["isConnected"] = true;
  return service;
}

// Every mongoose model shares ONE mocked object in this setup, so a single
// findOne return has to satisfy every reader (the achievements record AND the
// voice/message tracking docs). Set the same object on both handles.
function setSharedDoc(doc: unknown): void {
  (UserAchievements.findOne as jest.Mock).mockResolvedValue(doc);
  (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(doc);
}

describe("AchievementsService — progress & engagement (#654)", () => {
  beforeEach(() => {
    (UserAchievements.findOne as jest.Mock).mockReset();
    (UserAchievements.findOne as jest.Mock).mockResolvedValue(null);
    (VoiceChannelTracking.findOne as jest.Mock).mockReset();
    (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue(null);
    (VoiceChannelTracking.aggregate as jest.Mock).mockReset();
    (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);
    (AchievementsService as unknown as { instance: unknown }).instance =
      undefined;
  });

  describe("reserved weekly achievement metadata", () => {
    it.each([
      ["weekly_champion", "Weekly Champion"],
      ["weekly_night_owl", "Night Owl"],
      ["weekly_marathon", "Marathoner"],
      ["weekly_social_butterfly", "Social Butterfly"],
      ["weekly_consistent", "Consistent"],
    ])("exposes a definition for %s", (type, name) => {
      const def = createService().getAchievementDefinition(type);
      expect(def).toBeDefined();
      expect(def?.name).toBe(name);
    });
  });

  describe("engagement accolade metadata", () => {
    it.each([
      ["chatterbox", "Chatterbox"],
      ["reactor", "Reactor"],
      ["poll_regular", "Poll Regular"],
    ])("exposes a definition for %s", (type, name) => {
      const def = createService().getAccoladeDefinition(type);
      expect(def).toBeDefined();
      expect(def?.name).toBe(name);
    });
  });

  // Reach into the private logic records the same way achievements-service.test.ts does.
  function achievementLogic(service: AchievementsService, type: string) {
    return (service as never)["achievementLogic"][type];
  }

  describe("weekly_champion logic", () => {
    it("awards the user who tops this week's leaderboard", async () => {
      const service = createService();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: "user1", totalTime: 7200 },
      ]);
      expect(
        await achievementLogic(service, "weekly_champion").checkFunction(
          "user1",
          null,
          "UTC",
        ),
      ).toBe(true);
    });

    it("does not award a non-leader", async () => {
      const service = createService();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: "someone-else", totalTime: 7200 },
      ]);
      expect(
        await achievementLogic(service, "weekly_champion").checkFunction(
          "user1",
          null,
          "UTC",
        ),
      ).toBe(false);
    });

    it("does not award when there is no weekly activity", async () => {
      const service = createService();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([]);
      expect(
        await achievementLogic(service, "weekly_champion").checkFunction(
          "user1",
          null,
          "UTC",
        ),
      ).toBe(false);
    });

    it("reports the leader's weekly hours in metadata", async () => {
      const service = createService();
      (VoiceChannelTracking.aggregate as jest.Mock).mockResolvedValue([
        { _id: "user1", totalTime: 10800 }, // 3h
      ]);
      const meta = await achievementLogic(
        service,
        "weekly_champion",
      ).metadataFunction("user1", null, "UTC");
      expect(meta.value).toBe(3);
      expect(meta.unit).toBe("hrs");
    });
  });

  describe("weekly threshold logic", () => {
    const weekStart = startOfWeekUtc();

    it("weekly_marathon awards on a 4h+ session this week", async () => {
      const service = createService();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        sessions: [
          {
            startTime: new Date(weekStart.getTime() + 3600_000),
            endTime: new Date(weekStart.getTime() + 3600_000 + 14400_000),
            duration: 14400,
            otherUsers: [],
          },
        ],
      });
      expect(
        await achievementLogic(service, "weekly_marathon").checkFunction(
          "u",
          null,
          "UTC",
        ),
      ).toBe(true);
    });

    it("weekly_marathon does not award a sub-4h week", async () => {
      const service = createService();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        sessions: [
          {
            startTime: new Date(weekStart.getTime() + 3600_000),
            endTime: new Date(weekStart.getTime() + 3600_000 + 3600_000),
            duration: 3600,
            otherUsers: [],
          },
        ],
      });
      expect(
        await achievementLogic(service, "weekly_marathon").checkFunction(
          "u",
          null,
          "UTC",
        ),
      ).toBe(false);
    });

    it("weekly_social_butterfly awards with 5+ unique users this week", async () => {
      const service = createService();
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        sessions: [
          {
            startTime: new Date(weekStart.getTime() + 1000),
            endTime: new Date(weekStart.getTime() + 7200_000),
            duration: 7200,
            otherUsers: ["a", "b", "c", "d", "e"],
          },
        ],
      });
      const logic = achievementLogic(service, "weekly_social_butterfly");
      expect(await logic.checkFunction("u", null, "UTC")).toBe(true);
      const meta = await logic.metadataFunction("u", null, "UTC");
      expect(meta.value).toBe(5);
      expect(meta.unit).toBe("users");
    });

    it("weekly_consistent counts distinct active days", async () => {
      const service = createService();
      const sessions = [0, 1, 2, 3, 4].map((d) => ({
        startTime: new Date(Date.UTC(2026, 0, 5 + d, 12, 0, 0)),
        endTime: new Date(weekStart.getTime() + 3600_000),
        duration: 600,
        otherUsers: [],
      }));
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        sessions,
      });
      const logic = achievementLogic(service, "weekly_consistent");
      expect(await logic.checkFunction("u", null, "UTC")).toBe(true);
      expect((await logic.metadataFunction("u", null, "UTC")).value).toBe(5);
    });

    it("weekly_night_owl awards on 5h+ of late-night time", async () => {
      const service = createService();
      // Monday 23:00 UTC -> Tuesday 05:00 UTC = 6h late-night.
      (VoiceChannelTracking.findOne as jest.Mock).mockResolvedValue({
        sessions: [
          {
            startTime: new Date(weekStart.getTime() + 23 * 3600_000),
            endTime: new Date(weekStart.getTime() + 29 * 3600_000),
            duration: 6 * 3600,
            otherUsers: [],
          },
        ],
      });
      const logic = achievementLogic(service, "weekly_night_owl");
      expect(await logic.checkFunction("u", null, "UTC")).toBe(true);
      expect((await logic.metadataFunction("u", null, "UTC")).value).toBe(6);
    });
  });

  describe("engagement accolade award gating", () => {
    it("awards chatterbox when messagetracking is on and the milestone is met", async () => {
      const service = createService(
        {
          "messagetracking.enabled": true,
          "reactiontracking.enabled": false,
          "polls.participation.enabled": false,
        },
        "guild-1",
      );
      // One doc doubles as the achievements record and the message doc.
      setSharedDoc({
        accolades: [],
        statistics: { totalAccolades: 0, totalAchievements: 0 },
        save: jest.fn().mockResolvedValue(undefined),
        totalCount: 1000,
        sessions: [],
      });

      const result = await service.checkAndAwardAccolades("u", "U");
      expect(result.map((a) => a.type)).toContain("chatterbox");
    });

    it("never awards chatterbox while messagetracking is off", async () => {
      const service = createService(
        { "messagetracking.enabled": false },
        "guild-1",
      );
      setSharedDoc({
        accolades: [],
        statistics: { totalAccolades: 0, totalAchievements: 0 },
        save: jest.fn().mockResolvedValue(undefined),
        totalCount: 999999,
        sessions: [],
      });

      const result = await service.checkAndAwardAccolades("u", "U");
      expect(result.map((a) => a.type)).not.toContain("chatterbox");
    });
  });

  describe("getUnearnedAccoladeProgress", () => {
    it("returns unearned threshold accolades sorted by completion", async () => {
      const service = createService({
        "messagetracking.enabled": false,
        "reactiontracking.enabled": false,
        "polls.participation.enabled": false,
      });
      setSharedDoc({ accolades: [], totalTime: 90 * 3600, sessions: [] });

      const progress = await service.getUnearnedAccoladeProgress("u", 5);

      expect(progress.length).toBeGreaterThan(0);
      // voice_veteran_100 is the closest (90/100 = 90%).
      expect(progress[0].type).toBe("voice_veteran_100");
      expect(progress[0].current).toBe(90);
      expect(progress[0].target).toBe(100);
      expect(progress[0].percent).toBe(90);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i - 1].percent).toBeGreaterThanOrEqual(
          progress[i].percent,
        );
      }
      // first_hour is already complete (90 >= 1) so it is excluded.
      expect(progress.map((p) => p.type)).not.toContain("first_hour");
    });

    it("excludes already-earned accolades", async () => {
      const service = createService();
      setSharedDoc({
        accolades: [{ type: "voice_veteran_100" }],
        totalTime: 90 * 3600,
        sessions: [],
      });
      const progress = await service.getUnearnedAccoladeProgress("u", 10);
      expect(progress.map((p) => p.type)).not.toContain("voice_veteran_100");
    });

    it("caps the result count to the requested limit", async () => {
      const service = createService();
      setSharedDoc({ accolades: [], totalTime: 90 * 3600, sessions: [] });
      const progress = await service.getUnearnedAccoladeProgress("u", 2);
      expect(progress.length).toBeLessThanOrEqual(2);
    });

    it("omits engagement accolades whose capture key is off", async () => {
      const service = createService(
        { "messagetracking.enabled": false },
        "guild-1",
      );
      setSharedDoc({
        accolades: [],
        totalCount: 999,
        totalTime: 0,
        sessions: [],
      });
      const progress = await service.getUnearnedAccoladeProgress("u", 50);
      expect(progress.map((p) => p.type)).not.toContain("chatterbox");
    });

    it("includes engagement progress when the capture key is on", async () => {
      const service = createService(
        {
          "messagetracking.enabled": true,
          "reactiontracking.enabled": false,
          "polls.participation.enabled": false,
        },
        "guild-1",
      );
      // One object doubles as voice data (totalTime 0 → veterans skipped) and
      // the message-activity doc (totalCount 750 → 75% of the 1,000 target).
      setSharedDoc({
        accolades: [],
        totalTime: 0,
        totalCount: 750,
        sessions: [],
      });

      const progress = await service.getUnearnedAccoladeProgress("u", 50);
      const chatterbox = progress.find((p) => p.type === "chatterbox");
      expect(chatterbox).toBeDefined();
      expect(chatterbox?.current).toBe(750);
      expect(chatterbox?.target).toBe(1000);
      expect(chatterbox?.percent).toBe(75);
    });

    it("returns an empty array on error", async () => {
      const service = createService();
      (UserAchievements.findOne as jest.Mock).mockRejectedValue(
        new Error("DB error"),
      );
      expect(await service.getUnearnedAccoladeProgress("u")).toEqual([]);
    });
  });
});
