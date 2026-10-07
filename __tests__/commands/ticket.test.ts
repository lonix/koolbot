import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

const manager = {
  isEnabled: jest.fn<() => Promise<boolean>>(),
  openTicket: jest.fn<(i: unknown) => Promise<unknown>>(),
  findById: jest.fn<(g: string, id: string) => Promise<unknown>>(),
  findByChannel: jest.fn<(g: string, c: string) => Promise<unknown>>(),
  getSettings: jest.fn<() => Promise<unknown>>(),
  isStaff: jest.fn<(m: unknown, r: string) => boolean>(),
  claimTicket: jest.fn<(t: unknown, u: string) => Promise<unknown>>(),
  closeTicket: jest.fn<(t: unknown, u: string) => Promise<unknown>>(),
};

jest.unstable_mockModule(
  "../../src/services/ticket-channel-manager.js",
  () => ({
    MAX_SUBJECT_LENGTH: 100,
    TicketChannelManager: { getInstance: jest.fn(() => manager) },
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

const { execute, data } = await import("../../src/commands/ticket.js");

function makeInteraction(
  sub: string,
  options: Record<string, string> = {},
): { interaction: ChatInputCommandInteraction; editReply: jest.Mock } {
  const editReply = jest.fn(async () => undefined);
  const interaction = {
    guild: { members: { fetch: jest.fn(async () => ({ id: "member" })) } },
    guildId: "g1",
    channelId: "chan-1",
    user: { id: "u1", username: "ola" },
    client: {},
    deferReply: jest.fn(async () => undefined),
    reply: jest.fn(async () => undefined),
    editReply,
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => options[name] ?? null,
    },
  } as unknown as ChatInputCommandInteraction;
  // `getString(name, true)` must return the value for required options.
  (interaction.options as unknown as { getString: unknown }).getString = (
    name: string,
  ) => options[name] ?? null;
  return { interaction, editReply };
}

describe("/ticket", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.isEnabled.mockResolvedValue(true);
    manager.getSettings.mockResolvedValue({ staffRoleId: "staff" });
  });

  it("defines open, close and claim subcommands", () => {
    expect(data.toJSON().options?.map((o) => o.name)).toEqual([
      "open",
      "close",
      "claim",
    ]);
  });

  it("acknowledges ephemerally before any work", async () => {
    const { interaction } = makeInteraction("open", { subject: "help" });
    manager.openTicket.mockResolvedValue({
      ok: true,
      ticket: { channelId: "c9" },
    });
    await execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
  });

  it("opens a ticket and links the channel", async () => {
    const { interaction, editReply } = makeInteraction("open", {
      subject: "help",
    });
    manager.openTicket.mockResolvedValue({
      ok: true,
      ticket: { channelId: "c9" },
    });
    await execute(interaction);
    expect(manager.openTicket).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: "u1", subject: "help" }),
    );
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("<#c9>"),
    });
  });

  it("explains when the staff role is not configured", async () => {
    const { interaction, editReply } = makeInteraction("open", {
      subject: "help",
    });
    manager.openTicket.mockResolvedValue({
      ok: false,
      reason: "no-staff-role",
    });
    await execute(interaction);
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("staff role"),
    });
  });

  it("refuses when tickets are disabled", async () => {
    manager.isEnabled.mockResolvedValue(false);
    const { interaction, editReply } = makeInteraction("open", {
      subject: "help",
    });
    await execute(interaction);
    expect(manager.openTicket).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("disabled"),
    });
  });

  it("lets the author close their own ticket", async () => {
    const { interaction, editReply } = makeInteraction("close");
    manager.findByChannel.mockResolvedValue({ authorId: "u1" });
    manager.isStaff.mockReturnValue(false);
    manager.closeTicket.mockResolvedValue({ ok: true });
    await execute(interaction);
    expect(manager.closeTicket).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("closed"),
    });
  });

  it("stops a non-staff member closing someone else's ticket", async () => {
    const { interaction, editReply } = makeInteraction("close", { id: "abc" });
    manager.findById.mockResolvedValue({ authorId: "someone-else" });
    manager.isStaff.mockReturnValue(false);
    await execute(interaction);
    expect(manager.closeTicket).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: "Only staff can do that.",
    });
  });

  it("keeps claim staff-only, even for the ticket's author", async () => {
    const { interaction } = makeInteraction("claim");
    manager.findByChannel.mockResolvedValue({ authorId: "u1" });
    manager.isStaff.mockReturnValue(false);
    await execute(interaction);
    expect(manager.claimTicket).not.toHaveBeenCalled();
  });

  it("lets staff claim", async () => {
    const { interaction } = makeInteraction("claim");
    manager.findByChannel.mockResolvedValue({ authorId: "other" });
    manager.isStaff.mockReturnValue(true);
    manager.claimTicket.mockResolvedValue({ ok: true });
    await execute(interaction);
    expect(manager.claimTicket).toHaveBeenCalledWith(expect.anything(), "u1");
  });

  it("says so when there is no ticket here", async () => {
    const { interaction, editReply } = makeInteraction("close");
    manager.findByChannel.mockResolvedValue(null);
    await execute(interaction);
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("couldn't find a ticket"),
    });
  });
});
