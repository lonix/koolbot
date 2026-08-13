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

describe("ScheduledAnnouncementService.getAnnouncement", () => {
  let mockClient: Partial<Client>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { ScheduledAnnouncementService } =
      await import("../../src/services/scheduled-announcement-service.js");
    ScheduledAnnouncementService.reset();

    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      guilds: { fetch: jest.fn() } as any,
    } as Client;
  });

  it("returns the announcement when findById resolves", async () => {
    const announcement = { _id: "a1", guildId: "g1" };
    findById.mockResolvedValue(announcement);
    const { ScheduledAnnouncementService } =
      await import("../../src/services/scheduled-announcement-service.js");
    const service = ScheduledAnnouncementService.getInstance(
      mockClient as Client,
    );

    await expect(service.getAnnouncement("a1")).resolves.toBe(announcement);
  });

  it("returns null instead of throwing when findById rejects with a CastError (malformed id)", async () => {
    // Mongoose throws a CastError for a non-ObjectId id; the web toggle route
    // relies on null to take its audited "not found" path (#758).
    const castError = new Error("Cast to ObjectId failed");
    castError.name = "CastError";
    findById.mockImplementation(() => Promise.reject(castError));
    const { ScheduledAnnouncementService } =
      await import("../../src/services/scheduled-announcement-service.js");
    const service = ScheduledAnnouncementService.getInstance(
      mockClient as Client,
    );

    await expect(service.getAnnouncement("not-an-id")).resolves.toBeNull();
  });

  it("propagates non-CastError failures instead of masking them as not-found", async () => {
    findById.mockImplementation(() =>
      Promise.reject(new Error("connection timed out")),
    );
    const { ScheduledAnnouncementService } =
      await import("../../src/services/scheduled-announcement-service.js");
    const service = ScheduledAnnouncementService.getInstance(
      mockClient as Client,
    );

    await expect(service.getAnnouncement("a1")).rejects.toThrow(
      "connection timed out",
    );
  });
});
