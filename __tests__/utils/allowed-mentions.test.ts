import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, MessagePayload } from "discord.js";
import { DEFAULT_ALLOWED_MENTIONS } from "../../src/utils/allowed-mentions.js";

// #1146: the bot sets a safe client-level allowedMentions default, and a
// per-call value still wins so intentional pings keep pinging. These tests run
// the real discord.js payload resolution rather than asserting on our own
// constant.

function resolveAllowedMentions(
  client: Client,
  options: Record<string, unknown>,
): unknown {
  const target = { client } as never;
  const payload = new MessagePayload(target, options as never).resolveBody();
  return (payload.body as { allowed_mentions?: unknown }).allowed_mentions;
}

describe("client allowedMentions default (#1146)", () => {
  const client = new Client({
    intents: [],
    allowedMentions: DEFAULT_ALLOWED_MENTIONS,
  });

  it("does not resolve @everyone, @here or role mentions by default", () => {
    const allowed = resolveAllowedMentions(client, {
      content: "**@everyone** <@&123> is waiting",
    }) as { parse: string[] };
    expect(allowed.parse).toEqual(["users"]);
    expect(allowed.parse).not.toContain("everyone");
    expect(allowed.parse).not.toContain("roles");
  });

  it("keeps replies pinging their author", () => {
    const allowed = resolveAllowedMentions(client, { content: "x" }) as {
      replied_user?: boolean;
    };
    expect(allowed.replied_user).toBe(true);
  });

  it("lets an intentional role ping through with its own allow-list", () => {
    expect(
      resolveAllowedMentions(client, {
        content: "<@&123>",
        allowedMentions: { roles: ["123"] },
      }),
    ).toEqual({ roles: ["123"] });
  });

  it("is what the real Client in src/index.ts is constructed with", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/allowedMentions:\s*DEFAULT_ALLOWED_MENTIONS/);
  });
});
