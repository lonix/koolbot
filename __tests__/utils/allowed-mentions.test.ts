import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, MessagePayload } from "discord.js";
import {
  DEFAULT_ALLOWED_MENTIONS,
  NO_MENTIONS,
  escapeDisplayText,
  pingUsers,
} from "../../src/utils/allowed-mentions.js";

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

  it("does not resolve user, role, @everyone or @here mentions by default", () => {
    const allowed = resolveAllowedMentions(client, {
      content: "**@everyone** @here <@&123> <@456> is waiting",
    }) as { parse: string[]; users?: string[]; roles?: string[] };
    // An empty `parse` with no explicit ids means Discord pings nobody.
    expect(allowed.parse).toEqual([]);
    expect(allowed.users).toBeUndefined();
    expect(allowed.roles).toBeUndefined();
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

  it("lets an intentional user ping through with exactly that user", () => {
    expect(
      resolveAllowedMentions(client, {
        content: "<@42> your turn",
        allowedMentions: pingUsers("42"),
      }),
    ).toEqual({ users: ["42"] });
  });

  it("pingUsers lists each user once and nobody else", () => {
    expect(pingUsers("1", "2", "1")).toEqual({ users: ["1", "2"] });
    expect(pingUsers()).toEqual({ users: [] });
  });

  it("NO_MENTIONS resolves to an empty parse list", () => {
    expect(
      resolveAllowedMentions(client, {
        content: "x",
        allowedMentions: NO_MENTIONS,
      }),
    ).toEqual({ parse: [] });
  });

  it("is what the real Client in src/index.ts is constructed with", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/allowedMentions:\s*DEFAULT_ALLOWED_MENTIONS/);
  });
});

describe("escapeDisplayText (#1146)", () => {
  it("disarms user, role, channel and command mentions", () => {
    expect(escapeDisplayText("<@123>")).toBe("\\<@123\\>");
    expect(escapeDisplayText("<@!123>")).toBe("\\<@!123\\>");
    expect(escapeDisplayText("<@&123>")).toBe("\\<@&123\\>");
    expect(escapeDisplayText("<#123>")).toBe("\\<#123\\>");
    expect(escapeDisplayText("</cmd:123>")).toBe("\\</cmd:123\\>");
  });

  it("keeps @everyone and @here readable but breaks the token", () => {
    expect(escapeDisplayText("@everyone @HERE")).toBe(
      "@\u200beveryone @\u200bHERE",
    );
  });

  it("only breaks whole-word mass mentions", () => {
    expect(escapeDisplayText("@everyones @hereford @here_x @everyone1")).toBe(
      "@everyones @hereford @here\\_x @everyone1",
    );
    expect(escapeDisplayText("hi @everyone, @here! (@here)")).toBe(
      "hi @\u200beveryone, @\u200bhere! (@\u200bhere)",
    );
    expect(escapeDisplayText("@everyone@here")).toBe(
      "@\u200beveryone@\u200bhere",
    );
  });

  it("neutralises masked links and Markdown", () => {
    expect(escapeDisplayText("[free nitro](https://evil.example)")).toBe(
      "\\[free nitro\\](https://evil.example)",
    );
    expect(escapeDisplayText("**b** _i_ ~~s~~ ||x|| `c`")).toBe(
      "\\*\\*b\\*\\* \\_i\\_ \\~\\~s\\~\\~ \\|\\|x\\|\\| \\`c\\`",
    );
  });

  it("neutralises line-start headings, lists and quotes", () => {
    expect(escapeDisplayText("# big")).toBe("\\# big");
    expect(escapeDisplayText("- item")).toBe("\\- item");
    expect(escapeDisplayText("1. item")).toBe("1\\. item");
    expect(escapeDisplayText("> quote")).toBe("\\> quote");
  });

  it("escapes a backslash so the name cannot cancel its own escapes", () => {
    expect(escapeDisplayText("\\<@1>")).toBe("\\\\\\<@1\\>");
  });

  it("leaves an ordinary name untouched", () => {
    expect(escapeDisplayText("Alice Smith")).toBe("Alice Smith");
  });
});
