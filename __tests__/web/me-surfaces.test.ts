import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockEnv = { webui: { enabled: true } };
jest.unstable_mockModule("../../src/config/env.js", () => ({ env: mockEnv }));

const { isMeCommandEnabled, isAnyMeSurfaceEnabled } =
  await import("../../src/web/me-surfaces.js");
const { COMMAND_CONFIGS, isCommandEnabled } =
  await import("../../src/services/command-registry.js");

describe("/me availability (#1016)", () => {
  beforeEach(() => {
    mockEnv.webui.enabled = true;
  });

  it("counts the ungated surfaces, so a surface is always on", async () => {
    expect(await isAnyMeSurfaceEnabled()).toBe(true);
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
