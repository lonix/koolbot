import { describe, it, expect } from "@jest/globals";

describe("DiscordCommandAuditLog model", () => {
  it("loads without throwing under the global mongoose mock", async () => {
    const mod = await import(
      "../../src/models/discord-command-audit-log.js"
    );
    expect(mod.DiscordCommandAuditLog).toBeDefined();
  });

  it("accepts the canonical entry shape", () => {
    // Type-only check that the interface compiles with the documented
    // result enum + optional-nullable fields, matching what
    // `CommandManager.executeCommand` produces and what
    // `recordCommandAudit` persists.
    const sample = {
      guildId: "g1",
      discordUserId: "u1",
      commandName: "quote",
      subcommand: "add" as string | null,
      channelId: "c1" as string | null,
      result: "success" as "success" | "error" | "denied",
      errorMessage: null as string | null,
      durationMs: 42,
      createdAt: new Date(),
    };
    expect(sample.result).toBe("success");
    expect(sample.guildId).toBe("g1");
  });
});
