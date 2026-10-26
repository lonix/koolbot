import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

import { errorEmbedPayload } from "../test-utils.js";

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
    // Like discord.js: deferring marks the interaction, which is what makes a
    // failure answer edit the deferred reply instead of replying again.
    deferReply: jest.fn(async function (this: unknown) {
      (this as { deferred: boolean }).deferred = true;
    }),
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

  it("names the configured cap when a member has reached it", async () => {
    manager.openTicket.mockResolvedValue({
      ok: false,
      reason: "too-many-open",
      maxOpen: 3,
    });
    const { interaction, editReply } = makeInteraction("open", {
      subject: "help",
    });
    await execute(interaction);
    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Couldn't open a ticket",
        description: expect.stringContaining("3 open tickets"),
      }),
    );

    manager.openTicket.mockResolvedValue({
      ok: false,
      reason: "too-many-open",
      maxOpen: 1,
    });
    const single = makeInteraction("open", { subject: "help" });
    await execute(single.interaction);
    expect(single.editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Couldn't open a ticket",
        description: expect.stringContaining("1 open ticket,"),
      }),
    );
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

  // openTicket() creates a channel on every call, so once it has succeeded no
  // reply may tell the member to try again.
  it("says the ticket was opened, with no retry advice, when the confirmation fails", async () => {
    manager.openTicket.mockResolvedValue({
      ok: true,
      ticket: { channelId: "c9" },
    });
    const { interaction, editReply } = makeInteraction("open", {
      subject: "help",
    });
    editReply.mockRejectedValueOnce(new Error("Unknown interaction"));

    await expect(execute(interaction)).resolves.toBeUndefined();

    expect(manager.openTicket).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenLastCalledWith(
      errorEmbedPayload({
        title: "Your ticket was opened",
        description: expect.stringContaining("the ticket channels"),
      }),
    );
    expect(JSON.stringify(editReply.mock.calls)).not.toMatch(/try again/i);
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
    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Tickets aren't set up yet",
        description: expect.stringContaining("staff role"),
      }),
    );
  });

  it("refuses when tickets are disabled", async () => {
    manager.isEnabled.mockResolvedValue(false);
    const { interaction, editReply } = makeInteraction("open", {
      subject: "help",
    });
    await execute(interaction);
    expect(manager.openTicket).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Tickets are off",
        description: expect.stringContaining("Web UI"),
      }),
    );
  });

  it("lets the author close their own ticket", async () => {
    const { interaction, editReply } = makeInteraction("close");
    manager.findByChannel.mockResolvedValue({
      authorId: "u1",
      channelId: "chan-1",
    });
    manager.isStaff.mockReturnValue(false);
    manager.closeTicket.mockResolvedValue({ ok: true });
    await execute(interaction);
    expect(manager.closeTicket).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("closed"),
    });
  });

  it("stops an author closing their own ticket by ID from another channel", async () => {
    const { interaction, editReply } = makeInteraction("close", { id: "abc" });
    manager.findById.mockResolvedValue({
      authorId: "u1",
      channelId: "some-other-channel",
    });
    manager.isStaff.mockReturnValue(false);
    await execute(interaction);
    expect(manager.closeTicket).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Staff only",
        description: expect.stringContaining("Only staff can do that."),
      }),
    );
  });

  it("stops a non-staff member closing someone else's ticket", async () => {
    const { interaction, editReply } = makeInteraction("close", { id: "abc" });
    manager.findById.mockResolvedValue({ authorId: "someone-else" });
    manager.isStaff.mockReturnValue(false);
    await execute(interaction);
    expect(manager.closeTicket).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Staff only",
        description: expect.stringContaining("Only staff can do that."),
      }),
    );
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
    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Couldn't find a ticket",
        description: expect.stringContaining("ticket channel"),
      }),
    );
  });
});
