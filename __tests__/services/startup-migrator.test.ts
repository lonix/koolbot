import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { defaultConfig } from "../../src/services/config-schema.js";

// Regression cover for #867: `StartupMigrator` used to carry its own
// hardcoded per-migration defaults, which had drifted from
// `config-schema.ts`. On a fresh install (empty Mongo, no legacy env vars)
// it persisted `true` for six opt-in features, contradicting `SETTINGS.md`'s
// "most features are disabled by default" contract. Backfilled values must
// now come from `defaultConfig` and nowhere else.

const mockGet = jest.fn<(key: string) => Promise<unknown>>();
const mockSet =
  jest.fn<
    (
      key: string,
      value: unknown,
      description?: string,
      category?: string,
      options?: { skipDependencyCheck?: boolean },
    ) => Promise<void>
  >();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({ get: mockGet, set: mockSet })),
  },
}));

const mockHasEnv = jest.fn<(key: string) => boolean>();
jest.unstable_mockModule("../../src/config/env.js", () => ({
  hasEnv: mockHasEnv,
  getEnv: jest.fn(),
  env: {},
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const { StartupMigrator } =
  await import("../../src/services/startup-migrator.js");

/** The keys #867 reported as force-enabled on a fresh install. */
const OPT_IN_KEYS = [
  "voicechannels.enabled",
  "voicetracking.enabled",
  "voicetracking.seen.enabled",
  "voicetracking.announcements.enabled",
  "ping.enabled",
  "quotes.enabled",
] as const;

/** Values written by the run, keyed by config key. */
function writes(): Map<string, unknown> {
  return new Map(
    mockSet.mock.calls.map((call) => [call[0] as string, call[1]]),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasEnv.mockReturnValue(false);
  mockSet.mockResolvedValue(undefined);
  // Fresh install: nothing is in the database yet.
  mockGet.mockResolvedValue(null);
});

describe("StartupMigrator.checkForOutdatedSettings (#867)", () => {
  it("never enables an opt-in feature on a fresh install", async () => {
    await StartupMigrator.getInstance().checkForOutdatedSettings();

    const written = writes();
    for (const key of OPT_IN_KEYS) {
      expect(written.get(key)).toBe(false);
    }
  });

  it("backfills every key with its config-schema.ts default", async () => {
    await StartupMigrator.getInstance().checkForOutdatedSettings();

    for (const [key, value] of writes()) {
      expect(key in defaultConfig).toBe(true);
      expect(value).toStrictEqual(
        defaultConfig[key as keyof typeof defaultConfig],
      );
    }
  });

  it("writes schema-typed values rather than stringified ones", async () => {
    await StartupMigrator.getInstance().checkForOutdatedSettings();

    const written = writes();
    expect(written.get("quotes.max_length")).toBe(1000);
    expect(written.get("quotes.cooldown")).toBe(60);
    expect(written.get("voicechannels.enabled")).toBe(false);
  });

  it("bypasses dependency validation when backfilling (#663)", async () => {
    await StartupMigrator.getInstance().checkForOutdatedSettings();

    expect(mockSet).toHaveBeenCalled();
    for (const call of mockSet.mock.calls) {
      expect(call[4]).toEqual({ skipDependencyCheck: true });
    }
  });

  it("leaves settings that already exist untouched", async () => {
    mockGet.mockImplementation(async (key: string) =>
      key === "quotes.enabled" ? true : null,
    );

    await StartupMigrator.getInstance().checkForOutdatedSettings();

    expect(writes().has("quotes.enabled")).toBe(false);
  });

  it("writes nothing when every setting is already present", async () => {
    mockGet.mockImplementation(async (key: string) =>
      key.includes(".") ? "already-set" : null,
    );

    await StartupMigrator.getInstance().checkForOutdatedSettings();

    expect(mockSet).not.toHaveBeenCalled();
  });

  it("only targets keys declared in config-schema.ts", () => {
    for (const migration of StartupMigrator.getInstance().getMigrations()) {
      expect(migration.newKey in defaultConfig).toBe(true);
    }
  });
});
