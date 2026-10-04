import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockIsEnabled = jest.fn<() => Promise<boolean>>();
const mockRecordUser = jest.fn<() => Promise<void>>();
const mockGetHistory = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule("../../src/services/name-history-service.js", () => ({
  NameHistoryService: {
    getInstance: () => ({
      isEnabled: mockIsEnabled,
      recordUser: mockRecordUser,
      getHistory: mockGetHistory,
    }),
  },
}));

jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: { getInstance: () => ({ admission: () => 7 }) },
  }),
);

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, execute, formatHistory, chunkLines } =
  await import("../../src/commands/aka.js");

const d = new Date("2025-03-01T00:00:00Z");
const empty = { username: [], globalName: [], nickname: [] };

function makeInteraction(guildId: string | null = "g1") {
  return {
    guildId,
    options: {
      getUser: () => ({ id: "u2", username: "bob" }),
      getMember: () => ({ nickname: "Bobby" }),
    },
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deferReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    followUp: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & {
    followUp: jest.Mock;
    reply: jest.Mock;
    deferReply: jest.Mock;
    editReply: jest.Mock;
  };
}

describe("aka command", () => {
  beforeEach(() => {
    delete process.env.GUILD_MEMBERS_INTENT;
    mockIsEnabled.mockReset().mockResolvedValue(true);
    mockRecordUser.mockReset().mockResolvedValue(undefined);
    mockGetHistory.mockReset().mockResolvedValue(empty);
  });

  it("is named aka with a required user option", () => {
    expect(data.name).toBe("aka");
    expect(data.options).toHaveLength(1);
  });

  it("defers ephemerally before querying", async () => {
    const i = makeInteraction();
    await execute(i);
    expect(i.deferReply).toHaveBeenCalled();
    expect(i.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetHistory.mock.invocationCallOrder[0],
    );
  });

  it("says nothing is recorded yet when history is empty", async () => {
    const i = makeInteraction();
    await execute(i);
    const reply = (i.editReply.mock.calls[0] as [{ content: string }])[0];
    expect(reply.content).toContain("No name history recorded yet");
  });

  it("lists names grouped by kind", async () => {
    mockGetHistory.mockResolvedValue({
      ...empty,
      username: [{ name: "old_bob", firstSeenAt: d, lastSeenAt: d }],
      nickname: [{ name: "Bobby", firstSeenAt: d, lastSeenAt: d }],
    });
    const i = makeInteraction();
    await execute(i);
    const { content } = (i.editReply.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain("**Usernames**");
    expect(content).toContain("old\\_bob");
    expect(content).toContain("**Server nicknames**");
    expect(content).not.toContain("Display names");
  });

  it("warns that nicknames are not recorded when the intent is off", async () => {
    const i = makeInteraction();
    await execute(i);
    const { content } = (i.editReply.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain("GuildMembers");
  });

  it("omits the intent warning when the intent is on", async () => {
    process.env.GUILD_MEMBERS_INTENT = "true";
    const i = makeInteraction();
    await execute(i);
    const { content } = (i.editReply.mock.calls[0] as [{ content: string }])[0];
    expect(content).not.toContain("GuildMembers");
  });

  it("notes that recording is off and does not snapshot", async () => {
    mockIsEnabled.mockResolvedValue(false);
    const i = makeInteraction();
    await execute(i);
    expect(mockRecordUser).not.toHaveBeenCalled();
    const { content } = (i.editReply.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain("recording is turned off");
  });

  it("passes an admission ticket captured before deferring", async () => {
    const i = makeInteraction();
    await execute(i);
    expect(mockRecordUser.mock.calls[0]?.[3]).toBe(7);
  });

  it("refuses outside a guild", async () => {
    const i = makeInteraction(null);
    await execute(i);
    expect(i.reply).toHaveBeenCalled();
    expect(i.deferReply).not.toHaveBeenCalled();
  });

  it("spills a long history into ephemeral follow-ups without dropping rows", async () => {
    const rows = Array.from({ length: 60 }, (_, n) => ({
      name: `name_${n}_${"x".repeat(30)}`,
      firstSeenAt: d,
      lastSeenAt: d,
    }));
    mockGetHistory.mockResolvedValue({ ...empty, username: rows });
    const i = makeInteraction();
    await execute(i);
    const sent = [
      (i.editReply.mock.calls[0] as [{ content: string }])[0].content,
      ...(i.followUp.mock.calls as [{ content: string }][]).map(
        (c) => c[0].content,
      ),
    ];
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((m) => m.length <= 2000)).toBe(true);
    const all = sent.join("\n");
    for (let n = 0; n < 60; n++) expect(all).toContain(`name\\_${n}\\_`);
  });

  it("chunkLines never splits a line", () => {
    const chunks = chunkLines(["aaaa", "bbbb", "cccc"], 9);
    expect(chunks).toEqual(["aaaa\nbbbb", "cccc"]);
  });

  it("formatHistory escapes markdown and mentions in names", () => {
    const out = formatHistory({
      ...empty,
      username: [{ name: "@everyone*", firstSeenAt: d, lastSeenAt: d }],
    });
    expect(out).toContain("@​everyone\\*");
  });
});
