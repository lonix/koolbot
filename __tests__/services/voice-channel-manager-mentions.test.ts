/**
 * `VoiceChannelManager` message sends and mentions (#1146).
 *
 * The client default is `allowedMentions: { parse: [] }`, so every message that
 * pings the room owner or a joiner carries its own per-call list, and every
 * member-controlled name that reaches message content is escaped. A display
 * name containing `<@id>`, `@everyone`, Markdown or a masked link must neither
 * ping nor format.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  ButtonStyle,
  type Client,
  type GuildMember,
  type VoiceChannel,
} from "discord.js";

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(
        async (key: string) => key === "voicechannels.controlpanel.enabled",
      ),
      getNumber: jest.fn(async () => 0),
      getString: jest.fn(async (_key: string, fallback = "") => fallback),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: { getInstance: (): unknown => ({}) },
}));

const { VoiceChannelManager } =
  await import("../../src/services/voice-channel-manager.js");
type Manager = InstanceType<typeof VoiceChannelManager>;

/** Hostile on every axis the content renderer cares about. */
const HOSTILE =
  "<@555> <@&777> <#999> @everyone @here [free](https://evil.x) **b** # h";

/** What a safe rendering must not contain, whatever the surrounding text. */
function expectNeutral(text: string): void {
  expect(text).not.toContain("<@555>");
  expect(text).not.toContain("<@&777>");
  expect(text).not.toContain("<#999>");
  expect(text).not.toContain("@everyone");
  expect(text).not.toContain("@here");
  expect(text).not.toContain("[free](");
  expect(text).toContain("\\<@555\\>");
  expect(text).toContain("\\[free\\]");
  expect(text).toContain("\\*\\*b\\*\\*");
}

function memberNamed(id: string, displayName: string): GuildMember {
  return { id, displayName } as unknown as GuildMember;
}

function textChannel(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): { channel: VoiceChannel; send: jest.Mock } {
  const send = jest.fn(async () => ({ id: "sent-message" }));
  return {
    send: send as unknown as jest.Mock,
    channel: { id, name, send, ...extra } as unknown as VoiceChannel,
  };
}

/**
 * The controls post names the room only as a real mention (#1519), so the
 * member-controlled room name never reaches the embed text at all.
 */
function expectRoomNotNamed(description: string): void {
  expect(description).toContain("<#vc-1>");
  expect(description).not.toContain("555");
  expect(description).not.toContain("@everyone");
  expect(description).not.toContain("evil.x");
}

describe("VoiceChannelManager mentions (#1146)", () => {
  let client: Client;
  let manager: Manager;
  let internals: {
    userChannels: Map<string, unknown>;
    sendLiveDisclaimer: (c: VoiceChannel, m: GuildMember) => Promise<void>;
    notifyOwnerUserWaiting: (id: string, m: GuildMember) => Promise<void>;
    sendControlPanel: (c: VoiceChannel, ownerId: string) => Promise<void>;
    updateControlPanelOwnership: (
      c: VoiceChannel,
      ownerId: string,
    ) => Promise<void>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    VoiceChannelManager.reset();
    client = {
      user: { id: "bot" },
      channels: { cache: new Map() },
    } as unknown as Client;
    manager = VoiceChannelManager.getInstance(client);
    internals = manager as unknown as typeof internals;
  });

  afterEach(() => {
    VoiceChannelManager.reset();
  });

  it("live disclaimer pings only the joining member", async () => {
    const { channel, send } = textChannel("vc-1", "Room");

    await internals.sendLiveDisclaimer(channel, memberNamed("u-1", "x"));

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("<@u-1> 🔴 **Heads up!**"),
      allowedMentions: { users: ["u-1"] },
    });
  });

  it("waiting-room notice pings only the owner and escapes the waiting name", async () => {
    const { channel, send } = textChannel("vc-1", "Room");
    (client.channels.cache as Map<string, unknown>).set("vc-1", channel);
    internals.userChannels.set("owner-1", channel);

    await internals.notifyOwnerUserWaiting(
      "vc-1",
      memberNamed("waiter-1", HOSTILE),
    );

    const payload = send.mock.calls[0][0] as {
      content: string;
      allowedMentions: unknown;
      components: Array<{
        components: Array<{ data: { label: string; style: number } }>;
      }>;
    };
    expect(payload.allowedMentions).toEqual({ users: ["owner-1"] });
    expect(payload.content.startsWith("<@owner-1> ⏳ **")).toBe(true);
    expectNeutral(payload.content);
    // The button label is plain text in Discord, so it is not escaped.
    expect(payload.components[0].components[0].data.style).toBe(
      ButtonStyle.Primary,
    );
    expect(payload.components[0].components[0].data.label).toBe(
      `Let ${HOSTILE} in`,
    );
  });

  it("control panel pings only the owner and escapes the channel name", async () => {
    const { channel, send } = textChannel("vc-1", HOSTILE, {
      permissionOverwrites: { cache: new Map() },
      guild: { roles: { everyone: { id: "everyone" } } },
    });

    await internals.sendControlPanel(channel, "owner-1");

    const payload = send.mock.calls[0][0] as {
      content: string;
      allowedMentions: unknown;
      embeds: Array<{ data: { description: string } }>;
    };
    expect(payload.content).toBe("<@owner-1>");
    expect(payload.allowedMentions).toEqual({ users: ["owner-1"] });
    expectRoomNotNamed(payload.embeds[0].data.description);
  });

  it("control panel refresh after a transfer pings only the new owner", async () => {
    const edit = jest.fn(async () => undefined);
    const message = {
      id: "panel",
      author: { id: "bot" },
      embeds: [{ title: "🔊 Room controls" }],
      edit,
    };
    const { channel } = textChannel("vc-1", HOSTILE, {
      permissionOverwrites: { cache: new Map() },
      guild: { roles: { everyone: { id: "everyone" } } },
      messages: {
        fetch: jest.fn(async () => ({
          find: (fn: (m: typeof message) => boolean) =>
            fn(message) ? message : undefined,
        })),
      },
    });

    await internals.updateControlPanelOwnership(channel, "new-owner");

    const payload = edit.mock.calls[0][0] as {
      content: string;
      allowedMentions: unknown;
      embeds: Array<{ data: { description: string } }>;
    };
    expect(payload.content).toBe("<@new-owner>");
    expect(payload.allowedMentions).toEqual({ users: ["new-owner"] });
    expectRoomNotNamed(payload.embeds[0].data.description);
  });
});
