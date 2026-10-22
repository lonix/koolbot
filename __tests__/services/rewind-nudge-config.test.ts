import { describe, it, expect } from "@jest/globals";
import { isRewindNudgeEnabled } from "../../src/services/rewind-nudge-config.js";

const reader =
  (stored: Record<string, boolean>) =>
  async (key: string, fallback: boolean): Promise<boolean> =>
    key in stored ? stored[key] : fallback;

describe("isRewindNudgeEnabled (#608, #1292)", () => {
  it("lets an explicitly stored nudge switch win, either way", async () => {
    expect(
      await isRewindNudgeEnabled(
        reader({ "rewind.enabled": true, "rewind.nudge.enabled": false }),
      ),
    ).toBe(false);
    expect(
      await isRewindNudgeEnabled(
        reader({ "rewind.enabled": true, "rewind.nudge.enabled": true }),
      ),
    ).toBe(true);
  });

  it("is off while the Rewind page is off, even with the nudge switch on (#1292)", async () => {
    expect(
      await isRewindNudgeEnabled(
        reader({ "rewind.enabled": false, "rewind.nudge.enabled": true }),
      ),
    ).toBe(false);
  });

  it("inherits rewind.enabled when the nudge switch was never stored", async () => {
    expect(await isRewindNudgeEnabled(reader({ "rewind.enabled": true }))).toBe(
      true,
    );
    expect(await isRewindNudgeEnabled(reader({}))).toBe(false);
  });

  it("passes a failed read through, so a strict caller can refuse to guess", async () => {
    await expect(
      isRewindNudgeEnabled(async () => {
        throw new Error("mongo down");
      }),
    ).rejects.toThrow("mongo down");
  });
});
