import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockEnv = { webui: { enabled: true } };
jest.unstable_mockModule("../../src/config/env.js", () => ({ env: mockEnv }));

const mockGetBoolean = jest
  .fn<(key: string, def: boolean) => Promise<boolean>>()
  .mockResolvedValue(false);
const mockGetBooleanStrict = jest
  .fn<(key: string, def: boolean) => Promise<boolean>>()
  .mockResolvedValue(false);
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getBoolean: mockGetBoolean,
      getBooleanStrict: mockGetBooleanStrict,
    }),
  },
}));

const {
  readMeSurfaceFlags,
  readMeSurfaceFlagsStrict,
  readMeNotificationAvailability,
  isMeCommandEnabled,
  isAnyMeSurfaceEnabled,
} = await import("../../src/web/me-surfaces.js");
const { COMMAND_CONFIGS, isCommandEnabled } =
  await import("../../src/services/command-registry.js");

describe("/me availability (#1016)", () => {
  beforeEach(() => {
    mockEnv.webui.enabled = true;
  });

  it("counts the ungated surfaces, so a surface is always on", async () => {
    expect(await isAnyMeSurfaceEnabled()).toBe(true);
  });

  it("reads every gated surface from its config key", async () => {
    mockGetBoolean.mockImplementation(async (key) => key === "rewind.enabled");
    expect(await readMeSurfaceFlags()).toEqual({
      rewindEnabled: true,
      presetsEnabled: false,
      birthdayEnabled: false,
      privacyEnabled: false,
    });
  });

  it("is enabled when the Web UI is on", async () => {
    expect(await isMeCommandEnabled()).toBe(true);
  });

  it("is disabled when the Web UI is off", async () => {
    mockEnv.webui.enabled = false;
    expect(await isMeCommandEnabled()).toBe(false);
  });

  it("is registered via COMMAND_CONFIGS with no config key, and re-evaluates on each call (reload)", async () => {
    const entry = COMMAND_CONFIGS.find((c) => c.name === "me")!;
    expect(entry.configKey).toBeNull();
    const getBoolean = jest.fn(async () => false);
    expect(await isCommandEnabled(entry, getBoolean)).toBe(true);
    mockEnv.webui.enabled = false;
    expect(await isCommandEnabled(entry, getBoolean)).toBe(false);
    expect(getBoolean).not.toHaveBeenCalled();
  });
});

describe("strict surface flags (#1292)", () => {
  it("reads every gated surface through the strict reader", async () => {
    mockGetBooleanStrict.mockImplementation(
      async (key) => key === "birthdays.enabled",
    );
    expect(await readMeSurfaceFlagsStrict()).toEqual({
      rewindEnabled: false,
      presetsEnabled: false,
      birthdayEnabled: true,
      privacyEnabled: false,
    });
  });

  it("rejects when a read fails instead of reading as off", async () => {
    mockGetBooleanStrict.mockRejectedValueOnce(new Error("mongo down"));
    await expect(readMeSurfaceFlagsStrict()).rejects.toThrow("mongo down");
  });
});

describe("notification availability (#1292)", () => {
  const ON = {
    rewindEnabled: true,
    presetsEnabled: true,
    birthdayEnabled: true,
    privacyEnabled: true,
  };
  const stored = (values: Record<string, boolean>): void => {
    mockGetBooleanStrict.mockImplementation(async (key, def) =>
      key in values ? values[key] : def,
    );
  };

  it("offers all three when each DM can be sent", async () => {
    stored({
      "achievements.enabled": true,
      "digest.enabled": true,
      "rewind.enabled": true,
      "rewind.nudge.enabled": true,
    });
    expect(await readMeNotificationAvailability(ON)).toEqual({
      achievements: true,
      digest: true,
      rewind: true,
    });
  });

  it("needs achievements AND their DM switch (which defaults on)", async () => {
    stored({ "achievements.enabled": true });
    expect((await readMeNotificationAvailability(ON)).achievements).toBe(true);
    stored({
      "achievements.enabled": true,
      "achievements.dm_notifications.enabled": false,
    });
    expect((await readMeNotificationAvailability(ON)).achievements).toBe(false);
    stored({ "achievements.dm_notifications.enabled": true });
    expect((await readMeNotificationAvailability(ON)).achievements).toBe(false);
  });

  it("needs digest.enabled for the digest", async () => {
    stored({});
    expect((await readMeNotificationAvailability(ON)).digest).toBe(false);
    stored({ "digest.enabled": true });
    expect((await readMeNotificationAvailability(ON)).digest).toBe(true);
  });

  it("needs the nudge AND the Rewind page for the Rewind row", async () => {
    stored({ "rewind.enabled": true, "rewind.nudge.enabled": true });
    expect((await readMeNotificationAvailability(ON)).rewind).toBe(true);
    // Nudge on, page off: the DM would link to a 404, so no row.
    expect(
      (await readMeNotificationAvailability({ ...ON, rewindEnabled: false }))
        .rewind,
    ).toBe(false);
    // Page on, nudge off.
    stored({ "rewind.enabled": true, "rewind.nudge.enabled": false });
    expect((await readMeNotificationAvailability(ON)).rewind).toBe(false);
  });

  it("inherits the legacy rewind.enabled for a nudge switch that was never stored", async () => {
    stored({ "rewind.enabled": true });
    expect((await readMeNotificationAvailability(ON)).rewind).toBe(true);
  });

  it("rejects when a read fails instead of hiding the row", async () => {
    mockGetBooleanStrict.mockRejectedValue(new Error("mongo down"));
    await expect(readMeNotificationAvailability(ON)).rejects.toThrow(
      "mongo down",
    );
    mockGetBooleanStrict.mockReset().mockResolvedValue(false);
  });
});
