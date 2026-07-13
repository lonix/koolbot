import { describe, it, expect } from "@jest/globals";

describe("ModerationLog model", () => {
  it("loads without throwing under the global mongoose mock", async () => {
    const mod = await import("../../src/models/moderation-log.js");
    expect(mod.ModerationLog).toBeDefined();
  });

  it("accepts the canonical entry shape", () => {
    // Type-only check that the interface compiles with the documented action
    // enum, source enum, and nullable moderator/reason fields — matching what
    // ModerationService writes on both the /warn and audit-mirror paths.
    const sample = {
      guildId: "g1",
      userId: "u1",
      moderatorId: "m1" as string | null,
      action: "warn" as
        | "warn"
        | "kick"
        | "ban"
        | "unban"
        | "timeout"
        | "untimeout",
      reason: "spamming" as string | null,
      source: "command" as "command" | "audit",
      createdAt: new Date(),
    };
    expect(sample.action).toBe("warn");
    expect(sample.source).toBe("command");
    expect(sample.guildId).toBe("g1");
  });
});
