import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { GuildMember } from "discord.js";

const mockGetBoolean =
  jest.fn<(key: string, def?: boolean) => Promise<boolean>>();
const mockGetString = jest.fn<(key: string, def?: string) => Promise<string>>();
const mockEnv = { guildId: "guild-1", guildMembersIntent: true };
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
    })),
  },
}));
jest.unstable_mockModule("../../src/config/env.js", () => ({ env: mockEnv }));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const { WelcomeService, renderWelcomeMessage, GREETED_TTL_MS } =
  await import("../../src/services/welcome-service.js");

const baseArgs = {
  userId: "42",
  displayName: "Kool",
  guildName: "Kool Place",
  rolesLink: "",
  rulesLink: "",
};

describe("renderWelcomeMessage", () => {
  it("fills every placeholder", () => {
    expect(
      renderWelcomeMessage(
        "{user} / {username} / {server} / {roles} / {rules}",
        {
          ...baseArgs,
          rolesLink: "https://x/y",
          rulesLink: "<#9>",
        },
      ),
    ).toBe("<@42> / Kool / Kool Place / https://x/y / <#9>");
  });

  it("collapses the gap left by blank {roles}/{rules}", () => {
    expect(
      renderWelcomeMessage(
        "Hi {user}! Pick roles {roles} and read {rules}",
        baseArgs,
      ),
    ).toBe("Hi <@42>! Pick roles and read");
    expect(renderWelcomeMessage("a  {roles}  b", baseArgs)).toBe("a b");
  });

  it("keeps the template verbatim when both links are set", () => {
    expect(
      renderWelcomeMessage("a  {roles} {rules}", {
        ...baseArgs,
        rolesLink: "R",
        rulesLink: "U",
      }),
    ).toBe("a  R U");
  });
});

describe("renderWelcomeMessage substitution safety", () => {
  it("does not re-expand placeholder-like names", () => {
    expect(
      renderWelcomeMessage("Hi {username} @ {server}", {
        ...baseArgs,
        displayName: "{rules}",
        guildName: "Pat {user}",
      }),
    ).toBe("Hi {rules} @ Pat {user}");
  });

  it("escapes Markdown in display and server names", () => {
    const out = renderWelcomeMessage("{username} / {server}", {
      ...baseArgs,
      displayName: "[rules](https://example.com)",
      guildName: "**Big** place",
    });
    expect(out).not.toContain("[rules](");
    expect(out).toContain("\\[rules\\]");
    expect(out).toContain("\\*\\*Big\\*\\*");
  });
});

describe("WelcomeService", () => {
  const send = jest.fn<(opts: unknown) => Promise<void>>();
  const fetchChannel = jest.fn<(id: string) => Promise<unknown>>();
  let cfg: Record<string, string | boolean>;

  const makeMember = (
    over: Partial<{ id: string; bot: boolean; guildId: string }> = {},
  ) =>
    ({
      id: over.id ?? "42",
      displayName: "Kool",
      user: { bot: over.bot ?? false },
      guild: {
        id: over.guildId ?? "guild-1",
        name: "Kool Place",
        channels: { fetch: fetchChannel },
      },
    }) as unknown as GuildMember;

  beforeEach(() => {
    jest.clearAllMocks();
    WelcomeService.reset();
    mockEnv.guildId = "guild-1";
    mockEnv.guildMembersIntent = true;
    cfg = {
      "welcome.enabled": true,
      "welcome.channel_id": "chan",
      "welcome.message": "Welcome {user} to {server} {roles}",
      "welcome.mention": true,
      "welcome.roles_message_id": "",
      "welcome.rules_channel_id": "",
      "reactionroles.message_channel_id": "",
    };
    mockGetBoolean.mockImplementation(
      async (k, d) => (cfg[k] as boolean) ?? d ?? false,
    );
    mockGetString.mockImplementation(
      async (k, d) => (cfg[k] as string) ?? d ?? "",
    );
    send.mockResolvedValue(undefined);
    fetchChannel.mockResolvedValue({ isTextBased: () => true, send });
  });

  afterEach(() => jest.useRealTimers());

  const svc = () => WelcomeService.getInstance();

  it("posts the rendered message and pings the member", async () => {
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenCalledWith({
      content: "Welcome <@42> to Kool Place",
      allowedMentions: { users: ["42"] },
    });
  });

  it("suppresses pings when welcome.mention is off", async () => {
    cfg["welcome.mention"] = false;
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
  });

  it("deep-links the role message, or the channel when no message id", async () => {
    cfg["reactionroles.message_channel_id"] = "rr";
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "Welcome <@42> to Kool Place <#rr>" }),
    );
    cfg["welcome.roles_message_id"] = "m1";
    await svc().handleMemberJoin(makeMember({ id: "43" }));
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content:
          "Welcome <@43> to Kool Place https://discord.com/channels/guild-1/rr/m1",
      }),
    );
  });

  it("mentions the rules channel for {rules}", async () => {
    cfg["welcome.message"] = "Read {rules}";
    cfg["welcome.rules_channel_id"] = "rules";
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Read <#rules>" }),
    );
  });

  it("does nothing when disabled", async () => {
    cfg["welcome.enabled"] = false;
    await svc().handleMemberJoin(makeMember());
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores bots and other guilds", async () => {
    await svc().handleMemberJoin(makeMember({ bot: true }));
    await svc().handleMemberJoin(makeMember({ guildId: "other" }));
    mockEnv.guildId = undefined as unknown as string;
    await svc().handleMemberJoin(makeMember());
    expect(send).not.toHaveBeenCalled();
  });

  it("warns once and skips when the channel is unset or unusable", async () => {
    cfg["welcome.channel_id"] = "";
    await svc().handleMemberJoin(makeMember());
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    cfg["welcome.channel_id"] = "gone";
    fetchChannel.mockRejectedValue(new Error("Unknown Channel"));
    await svc().handleMemberJoin(makeMember());
    fetchChannel.mockResolvedValue({ isTextBased: () => false });
    await svc().handleMemberJoin(makeMember());
    expect(mockLogger.warn).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws when sending fails", async () => {
    send.mockRejectedValue(new Error("Missing Permissions"));
    await expect(svc().handleMemberJoin(makeMember())).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("does not double-greet a quick rejoin, but greets again after the TTL", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await svc().handleMemberJoin(makeMember());
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + GREETED_TTL_MS + 1);
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("greets once when joins overlap", async () => {
    let release!: () => void;
    fetchChannel.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ isTextBased: () => true, send });
        }),
    );
    const first = svc().handleMemberJoin(makeMember());
    const second = svc().handleMemberJoin(makeMember());
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets a member be greeted later when the first attempt sent nothing", async () => {
    cfg["welcome.channel_id"] = "";
    await svc().handleMemberJoin(makeMember());
    cfg["welcome.channel_id"] = "chan";
    await svc().handleMemberJoin(makeMember());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("truncates a message that expands past Discord's limit", async () => {
    cfg["welcome.message"] = `${"a".repeat(1994)}{user}`;
    await svc().handleMemberJoin(makeMember({ id: "123456789012345678" }));
    const { content } = send.mock.calls[0][0] as { content: string };
    expect(content).toHaveLength(2000);
  });

  describe("warnIfIntentMissing", () => {
    it("warns when enabled without the intent", async () => {
      mockEnv.guildMembersIntent = false;
      expect(await svc().warnIfIntentMissing()).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("GUILD_MEMBERS_INTENT"),
      );
    });
    it("stays quiet when the intent is on or the feature is off", async () => {
      expect(await svc().warnIfIntentMissing()).toBe(false);
      mockEnv.guildMembersIntent = false;
      cfg["welcome.enabled"] = false;
      expect(await svc().warnIfIntentMissing()).toBe(false);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });
});
