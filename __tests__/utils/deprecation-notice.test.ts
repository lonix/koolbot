import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  isDeprecatedSlashCommand,
  shouldEmitDeprecationNotice,
  sendDeprecationNotice,
} from "../../src/utils/deprecation-notice.js";
import type { ChatInputCommandInteraction } from "discord.js";

const DEPRECATED_TOP_LEVEL = [
  "permissions",
  "setup",
  "announce",
  "announce-vc-stats",
  "poll",
  "reactrole",
  "notice",
  "dbtrunk",
  "vc",
  "botstats",
];

const NOT_DEPRECATED = [
  "ping",
  "voicestats",
  "seen",
  "quote",
  "achievements",
  "amikool",
  "help",
];

describe("isDeprecatedSlashCommand", () => {
  it("flags every admin slash command targeted by issue #385", () => {
    for (const name of DEPRECATED_TOP_LEVEL) {
      expect(isDeprecatedSlashCommand(name, null)).toBe(true);
    }
  });

  it("does not flag user-facing slash commands", () => {
    for (const name of NOT_DEPRECATED) {
      expect(isDeprecatedSlashCommand(name, null)).toBe(false);
      expect(isDeprecatedSlashCommand(name, "anything")).toBe(false);
    }
  });

  it("flags every /config subcommand except the web launcher", () => {
    for (const sub of [
      "list",
      "set",
      "import",
      "export",
      "reset",
      "reload",
    ]) {
      expect(isDeprecatedSlashCommand("config", sub)).toBe(true);
    }
  });

  it("does not flag /config web (the WebUI launcher)", () => {
    expect(isDeprecatedSlashCommand("config", "web")).toBe(false);
  });

  it("does not flag bare /config (no subcommand)", () => {
    expect(isDeprecatedSlashCommand("config", null)).toBe(false);
  });
});

function buildInteraction(
  overrides: Partial<ChatInputCommandInteraction> & {
    commandName: string;
    subcommand?: string | null;
    replied?: boolean;
    deferred?: boolean;
  },
): ChatInputCommandInteraction & {
  reply: jest.Mock;
  followUp: jest.Mock;
} {
  const reply = jest.fn().mockResolvedValue(undefined as never);
  const followUp = jest.fn().mockResolvedValue(undefined as never);
  const subcommand = overrides.subcommand ?? null;

  return {
    commandName: overrides.commandName,
    replied: overrides.replied ?? false,
    deferred: overrides.deferred ?? false,
    options: {
      getSubcommand: (_required?: boolean) => {
        if (subcommand === null) {
          if (_required === false) return null as unknown as string;
          throw new Error("no subcommand");
        }
        return subcommand;
      },
    },
    reply,
    followUp,
  } as unknown as ChatInputCommandInteraction & {
    reply: jest.Mock;
    followUp: jest.Mock;
  };
}

describe("shouldEmitDeprecationNotice", () => {
  it("returns true for a deprecated top-level command", () => {
    expect(
      shouldEmitDeprecationNotice(buildInteraction({ commandName: "vc" })),
    ).toBe(true);
  });

  it("returns true for a deprecated /config subcommand", () => {
    expect(
      shouldEmitDeprecationNotice(
        buildInteraction({ commandName: "config", subcommand: "set" }),
      ),
    ).toBe(true);
  });

  it("returns false for /config web (the launcher)", () => {
    expect(
      shouldEmitDeprecationNotice(
        buildInteraction({ commandName: "config", subcommand: "web" }),
      ),
    ).toBe(false);
  });

  it("returns false for user-facing commands", () => {
    expect(
      shouldEmitDeprecationNotice(buildInteraction({ commandName: "ping" })),
    ).toBe(false);
  });
});

describe("sendDeprecationNotice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does nothing for non-deprecated commands", async () => {
    const interaction = buildInteraction({ commandName: "ping" });
    await sendDeprecationNotice(interaction);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("uses followUp when the interaction has already been replied to", async () => {
    const interaction = buildInteraction({
      commandName: "vc",
      replied: true,
    });
    await sendDeprecationNotice(interaction);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("uses followUp when the interaction has been deferred", async () => {
    const interaction = buildInteraction({
      commandName: "permissions",
      deferred: true,
    });
    await sendDeprecationNotice(interaction);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("falls back to reply when the interaction has not been replied/deferred", async () => {
    const interaction = buildInteraction({ commandName: "botstats" });
    await sendDeprecationNotice(interaction);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("emits the notice for deprecated /config subcommands", async () => {
    const interaction = buildInteraction({
      commandName: "config",
      subcommand: "reload",
      replied: true,
    });
    await sendDeprecationNotice(interaction);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
  });

  it("does not emit the notice for /config web", async () => {
    const interaction = buildInteraction({
      commandName: "config",
      subcommand: "web",
      replied: true,
    });
    await sendDeprecationNotice(interaction);
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("swallows errors from the Discord client", async () => {
    const interaction = buildInteraction({
      commandName: "vc",
      replied: true,
    });
    (interaction.followUp as jest.Mock).mockRejectedValueOnce(
      new Error("network blip") as never,
    );

    await expect(sendDeprecationNotice(interaction)).resolves.toBeUndefined();
  });
});
