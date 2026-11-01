import { describe, it, expect } from "@jest/globals";
import {
  COMMAND_CONFIGS,
  COMMAND_GATING_KEYS,
} from "../../src/services/command-registry.js";

describe("COMMAND_GATING_KEYS (#1638)", () => {
  it("is every config key a registry entry is gated by, and nothing else", () => {
    const expected = new Set(
      COMMAND_CONFIGS.flatMap((c) => (c.configKey ? [c.configKey] : [])),
    );
    expect(COMMAND_GATING_KEYS).toEqual(expected);
    expect(COMMAND_GATING_KEYS.has("quotes.enabled")).toBe(true);
    expect(COMMAND_GATING_KEYS.has("moderation.enabled")).toBe(true);
    expect(COMMAND_GATING_KEYS.has("polls.enabled")).toBe(false);
  });
});
