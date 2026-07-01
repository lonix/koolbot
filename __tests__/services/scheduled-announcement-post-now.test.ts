import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

// ESM-safe module mocks (jest.unstable_mockModule + dynamic import).
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      registerReloadCallback: jest.fn(),
      getBoolean: jest.fn().mockResolvedValue(false),
      getString: jest.fn().mockResolvedValue(""),
    }),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const findById = jest.fn();
jest.unstable_mockModule("../../src/models/scheduled-announcement.js", () => ({
  ScheduledAnnouncement: {
    find: jest.fn().mockResolvedValue([]),
    findById,
  },
}));

describe("ScheduledAnnouncementService.postAnnouncementNow", () => {
  let mockClient: Partial<Client>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { ScheduledAnnouncementService } = await import(
      "../../src/services/scheduled-announcement-service.js"
    );
    ScheduledAnnouncementService.reset();

    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      guilds: { fetch: jest.fn() } as any,
    } as Client;
  });

  it("returns false when the announcement does not exist", async () => {
    findById.mockResolvedValue(null);
    const { ScheduledAnnouncementService } = await import(
      "../../src/services/scheduled-announcement-service.js"
    );
    const service = ScheduledAnnouncementService.getInstance(
      mockClient as Client,
    );

    await expect(service.postAnnouncementNow("missing", "g1")).resolves.toBe(
      false,
    );
    // Guild is never fetched when the announcement is missing.
    expect(mockClient.guilds!.fetch).not.toHaveBeenCalled();
  });

  it("returns false when the announcement belongs to another guild", async () => {
    findById.mockResolvedValue({
      _id: "a1",
      guildId: "other-guild",
      channelId: "c1",
      message: "hi",
      placeholders: false,
    });
    const { ScheduledAnnouncementService } = await import(
      "../../src/services/scheduled-announcement-service.js"
    );
    const service = ScheduledAnnouncementService.getInstance(
      mockClient as Client,
    );

    await expect(service.postAnnouncementNow("a1", "g1")).resolves.toBe(false);
    // Cross-guild guard short-circuits before touching Discord.
    expect(mockClient.guilds!.fetch).not.toHaveBeenCalled();
  });
});
