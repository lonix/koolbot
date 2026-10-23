import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockGetBoolean =
  jest.fn<(key: string, def?: boolean) => Promise<boolean>>();
const mockGetString = jest.fn<(key: string, def?: string) => Promise<string>>();
const mockSet = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: { getInstance: jest.fn(() => ({})) },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
      set: mockSet,
    })),
  },
}));
jest.unstable_mockModule("../../src/config/env.js", () => ({
  env: { guildId: "g1", guildMembersIntent: true },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));
jest.unstable_mockModule("../../src/models/rules-acceptance.js", () => ({
  RulesAcceptance: {
    updateOne: jest.fn(),
    find: jest.fn(),
    bulkWrite: jest.fn(),
  },
}));

const { RulesService } = await import("../../src/services/rules-service.js");

describe("RulesService.repostMessage (#1428)", () => {
  const BOT = "bot1";
  let config: Record<string, string>;
  let calls: string[];
  const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const fetchMessage = jest.fn<(id: string) => Promise<unknown>>();
  const oldDelete = jest.fn<() => Promise<unknown>>();
  const newDelete = jest.fn<() => Promise<unknown>>();
  let textBased = true;
  const discordError = (code: number): Error =>
    Object.assign(new Error(`Discord ${code}`), { code });

  const guild = (): never =>
    ({
      id: "g1",
      channels: {
        fetch: jest.fn(async (id: string) =>
          id === "c1"
            ? {
                id: "c1",
                name: "rules",
                isTextBased: () => textBased,
                send,
                messages: { fetch: fetchMessage },
              }
            : null,
        ),
      },
    }) as never;

  const service = (): InstanceType<typeof RulesService> => {
    RulesService.reset();
    return RulesService.getInstance({ user: { id: BOT } } as never);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    calls = [];
    textBased = true;
    config = {
      "rules.channel_id": "c1",
      "rules.message": "Be kind.",
      "rules.message_id": "old1",
    };
    mockGetBoolean.mockResolvedValue(true);
    mockGetString.mockImplementation(async (k) => config[k] ?? "");
    mockSet.mockImplementation(async (...args: unknown[]) => {
      calls.push("store");
      config[args[0] as string] = args[1] as string;
    });
    send.mockImplementation(async () => {
      calls.push("send");
      return { id: "new1", delete: newDelete };
    });
    oldDelete.mockImplementation(async () => {
      calls.push("delete-old");
    });
    newDelete.mockImplementation(async () => {
      calls.push("delete-new");
    });
    fetchMessage.mockResolvedValue({
      id: "old1",
      author: { id: BOT },
      delete: oldDelete,
    });
  });

  it("posts a new message with its button, stores the id, then deletes the old one", async () => {
    const r = await service().repostMessage(guild(), "old1");
    expect(r).toEqual({
      ok: true,
      messageId: "new1",
      oldMessageId: "old1",
      old: "deleted",
    });
    expect(calls).toEqual(["send", "store", "delete-old"]);
    const payload = send.mock.calls[0]?.[0] as {
      content: string;
      components: unknown[];
      allowedMentions: unknown;
    };
    expect(payload.content).toBe("Be kind.");
    expect(payload.components).toHaveLength(1);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(config["rules.message_id"]).toBe("new1");
  });

  it("succeeds when the old message is already deleted", async () => {
    fetchMessage.mockRejectedValue(discordError(10008));
    const r = await service().repostMessage(guild(), "old1");
    expect(r).toMatchObject({ ok: true, old: "not-found" });
    expect(config["rules.message_id"]).toBe("new1");
  });

  it("can't find the old message after the channel changed, and says so", async () => {
    // The old message is in the previous channel; this channel doesn't have it.
    fetchMessage.mockRejectedValue(discordError(10008));
    const r = await service().repostMessage(guild());
    expect(r).toMatchObject({ ok: true, old: "not-found" });
    expect(fetchMessage).toHaveBeenCalledWith("old1");
  });

  it("explains missing permissions and leaves the old message live", async () => {
    send.mockRejectedValue(discordError(50013));
    const r = await service().repostMessage(guild(), "old1");
    expect(r).toMatchObject({ ok: false, reason: "no-permission" });
    expect(config["rules.message_id"]).toBe("old1");
    expect(oldDelete).not.toHaveBeenCalled();
  });

  it("takes the new message down when the id can't be saved", async () => {
    mockSet.mockRejectedValue(new Error("mongo down"));
    const r = await service().repostMessage(guild(), "old1");
    expect(r).toMatchObject({ ok: false, reason: "not-saved" });
    expect(newDelete).toHaveBeenCalledTimes(1);
    expect(oldDelete).not.toHaveBeenCalled();
  });

  it("refuses when rules are off, or the channel is missing or not text", async () => {
    mockGetBoolean.mockResolvedValue(false);
    expect(await service().repostMessage(guild())).toMatchObject({
      ok: false,
      reason: "not-ready",
    });
    mockGetBoolean.mockResolvedValue(true);
    config["rules.channel_id"] = "";
    expect(await service().repostMessage(guild())).toMatchObject({
      reason: "not-ready",
    });
    config["rules.channel_id"] = "c1";
    textBased = false;
    expect(await service().repostMessage(guild())).toMatchObject({
      reason: "not-ready",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("re-posts once when the same form is submitted twice at the same time", async () => {
    const s = service();
    const results = await Promise.all([
      s.repostMessage(guild(), "old1"),
      s.repostMessage(guild(), "old1"),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "stale" });
  });

  it("does not delete a message the bot did not write", async () => {
    fetchMessage.mockResolvedValue({
      id: "old1",
      author: { id: "someone" },
      delete: oldDelete,
    });
    expect(await service().repostMessage(guild(), "old1")).toMatchObject({
      ok: true,
      old: "not-ours",
    });
    expect(oldDelete).not.toHaveBeenCalled();
  });
});
