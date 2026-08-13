import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { VoiceChannelAnnouncer } from "../../src/services/voice-channel-announcer.js";
import { VoiceChannelTracker } from "../../src/services/voice-channel-tracker.js";
import { AchievementsService } from "../../src/services/achievements-service.js";
import { PollParticipationTracker } from "../../src/services/poll-participation-tracker.js";
import { quoteService } from "../../src/services/quote-service.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/achievements-service.js");
jest.mock("../../src/services/quote-service.js");
jest.mock("../../src/services/poll-participation-tracker.js");
jest.mock("../../src/utils/logger.js");

describe("VoiceChannelAnnouncer", () => {
  let service: VoiceChannelAnnouncer;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    VoiceChannelAnnouncer.reset();
    mockClient = {
      user: { id: "123" },
      channels: { fetch: jest.fn() },
    };
    service = VoiceChannelAnnouncer.getInstance(mockClient);
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = VoiceChannelAnnouncer.getInstance(mockClient);
      const instance2 = VoiceChannelAnnouncer.getInstance(mockClient);

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance with a client", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(VoiceChannelAnnouncer);
    });
  });

  describe("public methods", () => {
    it("should have start method", () => {
      expect(typeof service.start).toBe("function");
    });

    it("should have makeAnnouncement method", () => {
      expect(typeof service.makeAnnouncement).toBe("function");
    });

    it("should have destroy method", () => {
      expect(typeof service.destroy).toBe("function");
    });
  });

  // The section methods carry all the recap logic (toggles, feature gates,
  // rendering, mention restriction, per-section failure isolation);
  // makeAnnouncement is a thin sequential awaiter over them. Exercising them
  // directly avoids the guild/channel-resolution plumbing while still covering
  // the behaviour a reviewer cares about.
  describe("recap sections (#777)", () => {
    let channel: { send: jest.Mock };

    // Route each config key to a fixed boolean; unknown keys fall back to the
    // caller-supplied default so real defaults (e.g. include_* → true) apply.
    function setConfig(overrides: Record<string, boolean>): void {
      (service as any).configService = {
        getBoolean: jest.fn(async (key: string, def = false) =>
          key in overrides ? overrides[key] : def,
        ),
        getString: jest.fn(async (_key: string, def = "") => def),
      };
    }

    beforeEach(() => {
      channel = { send: jest.fn<any>().mockResolvedValue(undefined) };
    });

    describe("announceVoiceStats", () => {
      it("skips sending when the section toggle is off", async () => {
        setConfig({ "voicetracking.announcements.include_voice_stats": false });
        await (service as any).announceVoiceStats(channel);
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("renders the leaderboard when there is activity", async () => {
        setConfig({ "voicetracking.announcements.include_voice_stats": true });
        ((VoiceChannelTracker as any).getInstance = jest.fn()).mockReturnValue({
          getTopUsers: jest.fn<any>().mockResolvedValue([
            { userId: "111", username: "Alice", totalTime: 3661 },
            { userId: "222", username: "Bob", totalTime: 600 },
          ]),
        });

        await (service as any).announceVoiceStats(channel);

        expect(channel.send).toHaveBeenCalledTimes(1);
        const msg = channel.send.mock.calls[0][0] as string;
        expect(msg).toContain("Weekly Voice Channel Activity Report");
        expect(msg).toContain("🥇 <@111>: 1h 1m");
        expect(msg).toContain("🥈 <@222>: 0h 10m");
      });

      it("posts the no-activity note when nobody was active", async () => {
        setConfig({ "voicetracking.announcements.include_voice_stats": true });
        ((VoiceChannelTracker as any).getInstance = jest.fn()).mockReturnValue({
          getTopUsers: jest.fn<any>().mockResolvedValue([]),
        });

        await (service as any).announceVoiceStats(channel);
        expect(channel.send).toHaveBeenCalledWith(
          "No voice channel activity recorded this week.",
        );
      });

      it("swallows its own errors (isolation contract)", async () => {
        setConfig({ "voicetracking.announcements.include_voice_stats": true });
        ((VoiceChannelTracker as any).getInstance = jest.fn()).mockReturnValue({
          getTopUsers: jest
            .fn<any>()
            .mockRejectedValue(new Error("tracker boom")),
        });

        await expect(
          (service as any).announceVoiceStats(channel),
        ).resolves.toBeUndefined();
      });
    });

    describe("announceQuoteOfWeek", () => {
      it("skips when the section toggle is off", async () => {
        setConfig({
          "voicetracking.announcements.include_quote_of_week": false,
          "quotes.enabled": true,
        });
        await (service as any).announceQuoteOfWeek(channel, new Date());
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("skips when the quotes feature is disabled", async () => {
        setConfig({
          "voicetracking.announcements.include_quote_of_week": true,
          "quotes.enabled": false,
        });
        await (service as any).announceQuoteOfWeek(channel, new Date());
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("skips when there is no qualifying quote", async () => {
        setConfig({
          "voicetracking.announcements.include_quote_of_week": true,
          "quotes.enabled": true,
        });
        ((quoteService as any).getTopQuoteSince =
          jest.fn<any>()).mockResolvedValue(null);
        await (service as any).announceQuoteOfWeek(channel, new Date());
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("renders a clean author mention and restricts allowed mentions", async () => {
        setConfig({
          "voicetracking.announcements.include_quote_of_week": true,
          "quotes.enabled": true,
        });
        ((quoteService as any).getTopQuoteSince =
          jest.fn<any>()).mockResolvedValue({
          content: "the best quote",
          authorId: "<@!555>",
          likes: 1,
        });

        await (service as any).announceQuoteOfWeek(channel, new Date());

        const arg = channel.send.mock.calls[0][0] as any;
        expect(arg.content).toContain("the best quote");
        expect(arg.content).toContain("<@555>");
        expect(arg.content).toContain("👍 1 like");
        // Only the resolved author is mentionable; no @everyone/@here/roles.
        expect(arg.allowedMentions).toEqual({ parse: [], users: ["555"] });
      });

      it("emits NO mention for a malformed author id (no unrelated ping)", async () => {
        setConfig({
          "voicetracking.announcements.include_quote_of_week": true,
          "quotes.enabled": true,
        });
        ((quoteService as any).getTopQuoteSince =
          jest.fn<any>()).mockResolvedValue({
          content: "legacy import",
          authorId: "user-999-imported",
          likes: 4,
        });

        await (service as any).announceQuoteOfWeek(channel, new Date());

        const arg = channel.send.mock.calls[0][0] as any;
        expect(arg.content).toContain("someone");
        expect(arg.content).not.toContain("<@");
        expect(arg.allowedMentions).toEqual({ parse: [] });
      });

      it("swallows its own errors (isolation contract)", async () => {
        setConfig({
          "voicetracking.announcements.include_quote_of_week": true,
          "quotes.enabled": true,
        });
        ((quoteService as any).getTopQuoteSince =
          jest.fn<any>()).mockRejectedValue(new Error("quote boom"));
        await expect(
          (service as any).announceQuoteOfWeek(channel, new Date()),
        ).resolves.toBeUndefined();
      });
    });

    describe("announcePollTurnout", () => {
      it("skips when the section toggle is off", async () => {
        setConfig({
          "voicetracking.announcements.include_poll_turnout": false,
          "polls.participation.enabled": true,
        });
        await (service as any).announcePollTurnout(channel, "g1", new Date());
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("skips when poll participation tracking is disabled", async () => {
        setConfig({
          "voicetracking.announcements.include_poll_turnout": true,
          "polls.participation.enabled": false,
        });
        await (service as any).announcePollTurnout(channel, "g1", new Date());
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("renders the voter count when at least one member voted", async () => {
        setConfig({
          "voicetracking.announcements.include_poll_turnout": true,
          "polls.participation.enabled": true,
        });
        ((PollParticipationTracker as any).getInstance =
          jest.fn()).mockReturnValue({
          getRecentVoterCount: jest.fn<any>().mockResolvedValue(3),
        });

        await (service as any).announcePollTurnout(channel, "g1", new Date());

        const msg = channel.send.mock.calls[0][0] as string;
        expect(msg).toContain("Poll Participation");
        expect(msg).toContain("3 members voted in polls this week");
      });

      it("skips when nobody voted", async () => {
        setConfig({
          "voicetracking.announcements.include_poll_turnout": true,
          "polls.participation.enabled": true,
        });
        ((PollParticipationTracker as any).getInstance =
          jest.fn()).mockReturnValue({
          getRecentVoterCount: jest.fn<any>().mockResolvedValue(0),
        });

        await (service as any).announcePollTurnout(channel, "g1", new Date());
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("swallows its own errors (isolation contract)", async () => {
        setConfig({
          "voicetracking.announcements.include_poll_turnout": true,
          "polls.participation.enabled": true,
        });
        ((PollParticipationTracker as any).getInstance =
          jest.fn()).mockReturnValue({
          getRecentVoterCount: jest
            .fn<any>()
            .mockRejectedValue(new Error("poll boom")),
        });

        await expect(
          (service as any).announcePollTurnout(channel, "g1", new Date()),
        ).resolves.toBeUndefined();
      });
    });

    describe("announceAccolades", () => {
      it("skips when the section toggle is off", async () => {
        setConfig({
          "voicetracking.announcements.include_accolades": false,
          "achievements.enabled": true,
          "achievements.announcements.enabled": true,
        });
        await (service as any).announceAccolades(channel);
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("skips when achievements are disabled", async () => {
        setConfig({
          "voicetracking.announcements.include_accolades": true,
          "achievements.enabled": false,
          "achievements.announcements.enabled": true,
        });
        await (service as any).announceAccolades(channel);
        expect(channel.send).not.toHaveBeenCalled();
      });

      it("renders accolades earned this week", async () => {
        setConfig({
          "voicetracking.announcements.include_accolades": true,
          "achievements.enabled": true,
          "achievements.announcements.enabled": true,
        });
        ((AchievementsService as any).getInstance = jest.fn()).mockReturnValue({
          getNewAccoladesSinceLastWeek: jest
            .fn<any>()
            .mockResolvedValue([
              { userId: "777", accolades: [{ type: "chatterbox" }] },
            ]),
          getAccoladeDefinition: jest
            .fn<any>()
            .mockReturnValue({ emoji: "🎖️", name: "Chatterbox" }),
        });

        await (service as any).announceAccolades(channel);

        const msg = channel.send.mock.calls[0][0] as string;
        expect(msg).toContain("New Accolades This Week");
        expect(msg).toContain("🎖️ <@777> earned **Chatterbox**!");
      });

      it("swallows its own errors (isolation contract)", async () => {
        setConfig({
          "voicetracking.announcements.include_accolades": true,
          "achievements.enabled": true,
          "achievements.announcements.enabled": true,
        });
        ((AchievementsService as any).getInstance = jest.fn()).mockReturnValue({
          getNewAccoladesSinceLastWeek: jest
            .fn<any>()
            .mockRejectedValue(new Error("accolade boom")),
        });

        await expect(
          (service as any).announceAccolades(channel),
        ).resolves.toBeUndefined();
      });
    });
  });
});
