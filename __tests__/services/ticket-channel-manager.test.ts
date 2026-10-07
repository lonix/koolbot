import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";

const mockGetBoolean =
  jest.fn<(key: string, fallback: boolean) => Promise<boolean>>();
const mockGetString =
  jest.fn<(key: string, fallback: string) => Promise<string>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
    })),
  },
}));

// Pass-through so the manager's REST calls run directly.
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: jest.fn(() => ({
      makeDiscordApiCall: (fn: () => Promise<unknown>) => fn(),
    })),
  },
}));

const mockCreate = jest.fn<(doc: unknown) => Promise<unknown>>();
const mockFindOneAndUpdate = jest.fn<(...a: unknown[]) => unknown>();
jest.unstable_mockModule("../../src/models/ticket.js", () => ({
  Ticket: {
    create: mockCreate,
    findOne: jest.fn(),
    findOneAndUpdate: mockFindOneAndUpdate,
    find: jest.fn(),
    countDocuments: jest.fn(),
  },
  TICKET_STATUSES: ["open", "claimed", "closed"],
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  TicketChannelManager,
  ticketChannelName,
  closedChannelName,
  reopenedChannelName,
  renderTranscript,
} = await import("../../src/services/ticket-channel-manager.js");

function config(overrides: Record<string, boolean | string> = {}): void {
  const values: Record<string, boolean | string> = {
    "tickets.enabled": true,
    "tickets.staff_role_id": "staff-role",
    "tickets.category_id": "cat-1",
    "tickets.transcript_on_close": false,
    ...overrides,
  };
  mockGetBoolean.mockImplementation(async (k) => values[k] as boolean);
  mockGetString.mockImplementation(async (k) => values[k] as string);
}

function makeClient(): { client: never; sends: jest.Mock } {
  const sends = jest.fn<(p: unknown) => Promise<unknown>>();
  sends.mockResolvedValue({ id: "msg-1" });
  const client = {
    user: { id: "bot-id" },
    channels: { fetch: jest.fn() },
  } as never;
  return { client, sends };
}

describe("ticket name helpers", () => {
  it("slugs the username into a Discord-safe channel name", () => {
    expect(ticketChannelName("Ola Nordmann!!", "ab12")).toBe(
      "ticket-ola-nordmann-ab12",
    );
    expect(ticketChannelName("日本語", "ab12")).toBe("ticket-ab12");
  });

  it("round-trips the archived name", () => {
    expect(closedChannelName("ticket-ola-ab12")).toBe("closed-ola-ab12");
    expect(closedChannelName("closed-ola-ab12")).toBe("closed-ola-ab12");
    expect(reopenedChannelName("closed-ola-ab12")).toBe("ticket-ola-ab12");
    expect(reopenedChannelName("ticket-ola-ab12")).toBe("ticket-ola-ab12");
  });

  it("renders a transcript oldest-first with attachments", () => {
    const text = renderTranscript([
      {
        createdAt: new Date("2026-01-01T10:00:00Z"),
        authorTag: "a#1",
        content: "hi",
        attachmentUrls: ["https://x/y.png"],
      },
    ]);
    expect(text).toContain("[2026-01-01T10:00:00.000Z] a#1:");
    expect(text).toContain("hi");
    expect(text).toContain("(attachment) https://x/y.png");
  });
});

describe("TicketChannelManager.openTicket", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    TicketChannelManager.reset();
    config();
  });

  function guildWith(channelSend: jest.Mock, deleteFn = jest.fn()): never {
    return {
      id: "guild-1",
      roles: { everyone: { id: "everyone-id" } },
      channels: {
        create: jest.fn(async () => ({
          id: "chan-1",
          send: channelSend,
          delete: deleteFn,
        })),
      },
    } as never;
  }

  it("refuses while disabled", async () => {
    config({ "tickets.enabled": false });
    const { client } = makeClient();
    const result = await TicketChannelManager.getInstance(client).openTicket({
      guild: guildWith(jest.fn()),
      authorId: "u1",
      authorName: "ola",
      subject: "help",
    });
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("refuses without a staff role", async () => {
    config({ "tickets.staff_role_id": "" });
    const { client } = makeClient();
    const result = await TicketChannelManager.getInstance(client).openTicket({
      guild: guildWith(jest.fn()),
      authorId: "u1",
      authorName: "ola",
      subject: "help",
    });
    expect(result).toEqual({ ok: false, reason: "no-staff-role" });
  });

  it("creates a private channel for the author and staff, hidden from everyone", async () => {
    const send = jest.fn(async () => ({}));
    const guild = guildWith(send);
    mockCreate.mockResolvedValue({
      _id: "t1",
      authorId: "u1",
      subject: "help",
    });
    const { client } = makeClient();

    const result = await TicketChannelManager.getInstance(client).openTicket({
      guild,
      authorId: "u1",
      authorName: "ola",
      subject: "  help  ",
    });

    expect(result.ok).toBe(true);
    const createArgs = (guild as unknown as { channels: { create: jest.Mock } })
      .channels.create.mock.calls[0][0] as {
      parent: string;
      permissionOverwrites: Array<{
        id: string;
        allow?: bigint[];
        deny?: bigint[];
      }>;
    };
    expect(createArgs.parent).toBe("cat-1");
    const byId = new Map(createArgs.permissionOverwrites.map((o) => [o.id, o]));
    expect(byId.get("everyone-id")?.deny).toContain(
      PermissionFlagsBits.ViewChannel,
    );
    expect(byId.get("u1")?.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(byId.get("staff-role")?.allow).toContain(
      PermissionFlagsBits.ViewChannel,
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        authorId: "u1",
        channelId: "chan-1",
        subject: "help",
      }),
    );
    // Only the author and staff role can be pinged by the welcome message.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { users: ["u1"], roles: ["staff-role"] },
      }),
    );
  });

  it("deletes the channel again when the record cannot be saved", async () => {
    const del = jest.fn(async () => undefined);
    const guild = guildWith(jest.fn(), del);
    mockCreate.mockRejectedValue(new Error("db down"));
    const { client } = makeClient();

    const result = await TicketChannelManager.getInstance(client).openTicket({
      guild,
      authorId: "u1",
      authorName: "ola",
      subject: "help",
    });

    expect(result).toEqual({ ok: false, reason: "discord-error" });
    expect(del).toHaveBeenCalled();
  });

  it("keeps the ticket when only the welcome message fails", async () => {
    const del = jest.fn(async () => undefined);
    const send = jest.fn(async () => {
      throw new Error("cannot send");
    });
    mockCreate.mockResolvedValue({
      _id: "t1",
      authorId: "u1",
      subject: "help",
    });
    const { client } = makeClient();
    const result = await TicketChannelManager.getInstance(client).openTicket({
      guild: guildWith(send, del),
      authorId: "u1",
      authorName: "ola",
      subject: "help",
    });
    expect(result.ok).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("TicketChannelManager transitions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    TicketChannelManager.reset();
    config();
  });

  function ticket(status: string): Record<string, unknown> {
    return {
      _id: "t1",
      authorId: "u1",
      channelId: "chan-1",
      status,
      claimedBy: null,
      closedBy: null,
      closedAt: null,
      transcriptMessageId: null,
      save: jest.fn(async () => undefined),
    };
  }

  function clientWithChannel(): {
    client: never;
    channel: Record<string, jest.Mock | string | number>;
  } {
    const channel = {
      type: 0, // ChannelType.GuildText
      name: "ticket-ola-ab12",
      send: jest.fn(async () => ({ id: "m" })),
      setName: jest.fn(async () => undefined),
      permissionOverwrites: { edit: jest.fn(async () => undefined) },
    };
    const client = {
      user: { id: "bot" },
      channels: { fetch: jest.fn(async () => channel) },
    } as never;
    return { client, channel };
  }

  it("claims atomically and refuses when the conditional update misses", async () => {
    const { client } = clientWithChannel();
    const manager = TicketChannelManager.getInstance(client);
    const t = ticket("open");
    mockFindOneAndUpdate.mockReturnValueOnce({
      exec: async () => ({ status: "claimed", claimedBy: "staff-1" }),
    });
    const first = await manager.claimTicket(t as never, "staff-1");
    expect(first.ok).toBe(true);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "t1", status: "open" },
      { $set: { status: "claimed", claimedBy: "staff-1" } },
      { new: true },
    );
    expect(t.claimedBy).toBe("staff-1");

    // A racing claim: the row is no longer open, so the update matches nothing.
    mockFindOneAndUpdate.mockReturnValueOnce({ exec: async () => null });
    const second = await manager.claimTicket(
      ticket("open") as never,
      "staff-2",
    );
    expect(second).toEqual({ ok: false, reason: "already-claimed" });
  });

  it("still locks and renames when the transcript fails", async () => {
    config({ "tickets.transcript_on_close": true });
    const { client, channel } = clientWithChannel();
    (channel as unknown as { messages: unknown }).messages = {
      fetch: jest.fn(async () => {
        throw new Error("no history access");
      }),
    };
    const result = await TicketChannelManager.getInstance(client).closeTicket(
      ticket("open") as never,
      "staff-1",
    );
    expect(result.ok).toBe(true);
    expect(channel.setName).toHaveBeenCalledWith("closed-ola-ab12");
    expect(
      (channel.permissionOverwrites as unknown as { edit: jest.Mock }).edit,
    ).toHaveBeenCalledWith(
      "u1",
      { SendMessages: false, SendMessagesInThreads: false },
      expect.anything(),
    );
  });

  it("closes: locks the author, archives the name, records who closed it", async () => {
    const { client, channel } = clientWithChannel();
    const manager = TicketChannelManager.getInstance(client);
    const t = ticket("open");

    const result = await manager.closeTicket(t as never, "staff-1");

    expect(result.ok).toBe(true);
    expect(
      (channel.permissionOverwrites as unknown as { edit: jest.Mock }).edit,
    ).toHaveBeenCalledWith(
      "u1",
      { SendMessages: false, SendMessagesInThreads: false },
      expect.anything(),
    );
    expect(channel.setName).toHaveBeenCalledWith("closed-ola-ab12");
    expect(t.status).toBe("closed");
    expect(t.closedBy).toBe("staff-1");
    expect(t.closedAt).toBeInstanceOf(Date);
    expect(await manager.closeTicket(t as never, "staff-1")).toEqual({
      ok: false,
      reason: "already-closed",
    });
  });

  it("still closes the record when the channel is already gone", async () => {
    const client = {
      user: { id: "bot" },
      channels: {
        fetch: jest.fn(async () => {
          throw new Error("Unknown Channel");
        }),
      },
    } as never;
    const t = ticket("claimed");
    const result = await TicketChannelManager.getInstance(client).closeTicket(
      t as never,
      "staff-1",
    );
    expect(result.ok).toBe(true);
    expect(t.status).toBe("closed");
  });

  it("reopens a closed ticket, restoring claimed when it had been claimed", async () => {
    const { client, channel } = clientWithChannel();
    channel.name = "closed-ola-ab12";
    const manager = TicketChannelManager.getInstance(client);
    const t = { ...ticket("closed"), claimedBy: "staff-1", closedBy: "u1" };

    const result = await manager.reopenTicket(t as never, "staff-2");

    expect(result.ok).toBe(true);
    expect(channel.setName).toHaveBeenCalledWith("ticket-ola-ab12");
    expect(t.status).toBe("claimed");
    expect(t.closedBy).toBeNull();
    expect(
      await manager.reopenTicket(ticket("open") as never, "staff-2"),
    ).toEqual({ ok: false, reason: "not-closed" });
  });

  it("only treats the staff role or administrators as staff", () => {
    const { client } = clientWithChannel();
    const manager = TicketChannelManager.getInstance(client);
    const member = (admin: boolean, roles: string[]): never =>
      ({
        permissions: { has: () => admin },
        roles: { cache: new Set(roles) },
      }) as never;
    expect(manager.isStaff(member(false, ["staff-role"]), "staff-role")).toBe(
      true,
    );
    expect(manager.isStaff(member(true, []), "staff-role")).toBe(true);
    expect(manager.isStaff(member(false, ["other"]), "staff-role")).toBe(false);
    expect(manager.isStaff(member(false, []), "")).toBe(false);
  });
});
