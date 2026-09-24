import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();
jest.unstable_mockModule("fs", () => ({ readFileSync: mockReadFileSync }));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Re-import per test so the module-level cache starts empty each time.
const loadGetBotVersion = async () =>
  (await import("../../src/utils/version.js")).getBotVersion;

describe("getBotVersion", () => {
  beforeEach(() => {
    jest.resetModules();
    mockReadFileSync.mockReset();
  });

  it("returns the package.json version", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "3.4.5" }));
    const getBotVersion = await loadGetBotVersion();
    expect(getBotVersion()).toBe("3.4.5");
  });

  it("reads package.json only once and caches the result", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "3.4.5" }));
    const getBotVersion = await loadGetBotVersion();
    getBotVersion();
    getBotVersion();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns 'unknown' when package.json cannot be read", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const getBotVersion = await loadGetBotVersion();
    expect(getBotVersion()).toBe("unknown");
  });

  it("returns 'unknown' when package.json is not valid JSON", async () => {
    mockReadFileSync.mockReturnValue("{ not json");
    const getBotVersion = await loadGetBotVersion();
    expect(getBotVersion()).toBe("unknown");
  });

  it.each([{}, { version: "" }, { version: 2 }])(
    "returns 'unknown' when the version is missing or invalid (%j)",
    async (pkg) => {
      mockReadFileSync.mockReturnValue(JSON.stringify(pkg));
      const getBotVersion = await loadGetBotVersion();
      expect(getBotVersion()).toBe("unknown");
    },
  );
});
