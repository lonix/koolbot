import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  // A listener registered outside index.ts is just as exposed, so any file in
  // src/ that attaches its own client listener must gate it too. `ready` is
  // not a guild event.
  it("gates every client listener registered outside index.ts", () => {
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcDir);

    const listener =
      /\bclient\.(?:on|once|addListener)\(\s*(?:"([A-Za-z]+)"|Events\.([A-Za-z]+))/g;
    const ungated: string[] = [];
    for (const file of files) {
      if (file === join(srcDir, "index.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(listener)) {
        const event = m[1] ?? m[2];
        if (event === "ready" || event === "ClientReady") continue;
        if (!text.includes("shouldIgnoreGuild(")) {
          ungated.push(`${file}: ${event}`);
        }
      }
    }
    expect(ungated).toEqual([]);
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
