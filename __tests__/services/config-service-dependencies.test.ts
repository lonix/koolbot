import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { ConfigService as ConfigServiceType } from "../../src/services/config-service.js";
import { DependencyError } from "../../src/services/config-schema.js";

// Write-time feature-dependency enforcement (#663): `ConfigService.set`
// refuses to enable a key whose `dependsOn` target is off, or to disable a key
// something still depends on, unless the caller opts out (bulk/system writers).

const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockDeleteOne = jest.fn();

jest.unstable_mockModule("../../src/models/config.js", () => ({
  Config: {
    findOne: mockFindOne,
    find: mockFind,
    findOneAndUpdate: mockFindOneAndUpdate,
    deleteOne: mockDeleteOne,
  },
  CONFIG_CATEGORIES: [
    "achievements",
    "core",
    "digest",
    "leaderboard_roles",
    "voicetracking",
  ],
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const mongooseMock = {
  connection: { readyState: 1, on: jest.fn() },
  connect: jest.fn(),
};
jest.unstable_mockModule("mongoose", () => ({
  ...mongooseMock,
  default: mongooseMock,
}));

const { ConfigService } = await import("../../src/services/config-service.js");

/**
 * Seed the persisted-config view used by the dependency resolver. Keys not
 * listed read as unset (→ false via getBoolean's fallback).
 */
function seedConfig(values: Record<string, unknown>): void {
  mockFindOne.mockImplementation(async (query: { key: string }) => {
    if (query.key in values) {
      return { key: query.key, value: values[query.key] };
    }
    return null;
  });
}

describe("ConfigService dependency enforcement (#663)", () => {
  let service: ConfigServiceType;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
    mockFind.mockResolvedValue([]);
    mockFindOneAndUpdate.mockResolvedValue({});
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
    process.env = { ...originalEnv };
    (ConfigService as unknown as { instance: unknown }).instance = undefined;
    service = ConfigService.getInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
    (ConfigService as unknown as { instance: unknown }).instance = undefined;
  });

  describe("set() forward direction", () => {
    it("rejects enabling a key whose dependency is disabled", async () => {
      seedConfig({ "voicetracking.enabled": false });

      await expect(
        service.set(
          "achievements.enabled",
          true,
          "Achievements",
          "achievements",
        ),
      ).rejects.toBeInstanceOf(DependencyError);

      // Nothing was written.
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("surfaces an operator-friendly message naming the unmet dependency", async () => {
      seedConfig({ "voicetracking.enabled": false });
      await expect(
        service.set(
          "achievements.enabled",
          true,
          "Achievements",
          "achievements",
        ),
      ).rejects.toThrow(/voicetracking\.enabled/);
    });

    it("allows enabling once the dependency is on", async () => {
      seedConfig({ "voicetracking.enabled": true });

      await service.set(
        "achievements.enabled",
        true,
        "Achievements",
        "achievements",
      );

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { key: "achievements.enabled" },
        expect.objectContaining({ key: "achievements.enabled", value: true }),
        { upsert: true, new: true },
      );
    });

    it("never blocks disabling a key (forward check only guards enabling)", async () => {
      seedConfig({ "voicetracking.enabled": false });

      await service.set(
        "achievements.enabled",
        false,
        "Achievements",
        "achievements",
      );

      expect(mockFindOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe("set() reverse direction", () => {
    it("blocks disabling a key while a dependent is enabled", async () => {
      seedConfig({
        "voicetracking.enabled": true,
        "achievements.enabled": true,
      });

      await expect(
        service.set(
          "voicetracking.enabled",
          false,
          "Voice Tracking",
          "voicetracking",
        ),
      ).rejects.toThrow(/achievements\.enabled/);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("allows disabling when no dependent is enabled", async () => {
      seedConfig({
        "voicetracking.enabled": true,
        "achievements.enabled": false,
      });

      await service.set(
        "voicetracking.enabled",
        false,
        "Voice Tracking",
        "voicetracking",
      );

      expect(mockFindOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe("skipDependencyCheck opt-out", () => {
    it("bypasses validation for bulk/system writers", async () => {
      seedConfig({ "voicetracking.enabled": false });

      await service.set(
        "achievements.enabled",
        true,
        "Achievements",
        "achievements",
        { skipDependencyCheck: true },
      );

      expect(mockFindOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe("non-schema keys", () => {
    it("are never blocked by dependency validation", async () => {
      await service.set("some.random.key", true, "desc", "core");
      expect(mockFindOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe("findDependencyIssues() batch", () => {
    it("passes when a feature and its dependency are enabled together", async () => {
      seedConfig({ "voicetracking.enabled": false });

      const issues = await service.findDependencyIssues({
        "voicetracking.enabled": true,
        "achievements.enabled": true,
      });
      expect(issues).toEqual([]);
    });

    it("flags a batch that enables a dependent without its dependency", async () => {
      seedConfig({ "voicetracking.enabled": false });

      const issues = await service.findDependencyIssues({
        "achievements.enabled": true,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].key).toBe("achievements.enabled");
    });
  });
});
