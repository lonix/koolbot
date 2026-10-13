import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/index.ts logs in and starts servers on import, so it cannot be loaded
// in a test. Instead pin that every guild-scoped gateway listener starts with
// the guild-scope gate (#1144): dropping it silently re-opens the hole.

const source = readFileSync(
  fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
  "utf8",
);

/** Body of each `client.on(Events.<name>, ...)` registration. */
function listenerBodies(event: string): string[] {
  const marker = `client.on(Events.${event},`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    const next = source.indexOf("\nclient.", start + marker.length);
    bodies.push(source.slice(start, next === -1 ? undefined : next));
    from = start + marker.length;
  }
  return bodies;
}

describe("guild scope wiring in src/index.ts (#1144)", () => {
  const scoped = [
    "InteractionCreate",
    "VoiceStateUpdate",
    "MessageCreate",
    "MessageReactionAdd",
    "MessageReactionRemove",
    "MessageDelete",
    "GuildRoleDelete",
    "GuildRoleUpdate",
    "ChannelDelete",
    "ChannelUpdate",
    "MessagePollVoteAdd",
    "GuildAuditLogEntryCreate",
    "GuildMemberUpdate",
    "GuildMemberAdd",
  ];

  it.each(scoped)("gates %s on the configured guild", (event) => {
    const bodies = listenerBodies(event);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toContain("shouldIgnoreGuild(");
    }
  });

  it("re-checks guild scope when the bot is added to a guild", () => {
    expect(listenerBodies("GuildCreate")[0]).toContain("enforceGuildScope");
  });

  it("only leaves guilds when the opt-in setting is on", () => {
    expect(source).toContain('"core.guild_scope.leave_other_guilds"');
    expect(source).toMatch(
      /applyGuildScope\(client\.guilds\.cache\.values\(\), env\.guildId, leave\)/,
    );
  });
});
