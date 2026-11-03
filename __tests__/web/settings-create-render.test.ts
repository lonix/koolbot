/**
 * The Picker's create row on the Settings pages (#1663): which settings show
 * it, the help line when creating cannot work, and the typed name kept in the
 * Picker after a refused save. Server markup only; the row's script is covered
 * in channel-picker-create.test.ts.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { ChannelType, type Client } from "discord.js";

const mockCanBotCreate = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: (
    kind: string,
    answer: { ok: unknown; reason?: string },
    channelKind?: string,
  ) =>
    answer.ok === "unknown"
      ? undefined
      : {
          kind,
          ...(channelKind ? { channelKind } : {}),
          ok: answer.ok,
          ...(answer.ok === false ? { reason: answer.reason } : {}),
        },
}));

const { renderSettingsPage, renderFeatureSettingsCard } =
  await import("../../src/web/admin-views.js");
type SettingRow = import("../../src/web/admin-views.js").SettingRow;
const { loadCreateChannelAnswer } =
  await import("../../src/web/setting-create-load.js");
const { pickerCreateFor, offersCreateChannel } =
  await import("../../src/web/setting-create.js");

const TEXT = [
  { id: "1", name: "general", type: ChannelType.GuildText, parentName: null },
];
const row = (key: string, current = ""): SettingRow =>
  ({
    key,
    label: key,
    current,
    defaultValue: "",
    type: "channel",
    description: "d",
    category: key.split(".")[0],
  }) as SettingRow;

const OK = { kind: "channel" as const, channelKind: "text" as const, ok: true };
const NO = { ...OK, ok: false, reason: "The bot needs Manage Channels." };

function settingsPage(
  keys: string[],
  answer: typeof OK | typeof NO | undefined,
  current = "",
): string {
  return renderSettingsPage({
    csrfToken: "t",
    guildId: "g",
    guildName: "G",
    flash: null,
    groups: [{ category: "x", rows: keys.map((k) => row(k, current)) }],
    textChannels: TEXT,
    voiceChannels: [],
    categoryChannels: [],
    roles: [],
    pickerCreate: pickerCreateFor(answer),
  } as unknown as Parameters<typeof renderSettingsPage>[0]);
}
/** The `create` flag of the picker of one key, or undefined for the plain array. */
function createOf(html: string, key: string): unknown {
  const at = html.indexOf(`name="value_${key}"`);
  const start = html.lastIndexOf("data-picker-meta=", at);
  const raw = (
    html.slice(start).match(/data-picker-meta="([^"]*)"/) as RegExpMatchArray
  )[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const meta = JSON.parse(raw);
  return Array.isArray(meta) ? undefined : meta.create;
}

describe("which settings offer the row", () => {
  it("only the flagged text channel settings, from the schema", () => {
    expect(offersCreateChannel("quotes.channel_id")).toBe(true);
    expect(offersCreateChannel("welcome.channel_id")).toBe(true);
    expect(offersCreateChannel("welcome.rules_channel_id")).toBe(false);
    expect(offersCreateChannel("voicechannels.lobby.channel_id")).toBe(false);
    expect(offersCreateChannel("core.errors.channel_id")).toBe(false);
    expect(offersCreateChannel("moderation.raid.alert_channel_id")).toBe(false);
    expect(offersCreateChannel("quotes.max_length")).toBe(false);
  });

  it("the Settings page flags a marked key and leaves the others as they were", () => {
    const html = settingsPage(
      [
        "quotes.channel_id",
        "welcome.rules_channel_id",
        "core.errors.channel_id",
      ],
      OK,
    );
    expect(createOf(html, "quotes.channel_id")).toEqual(OK);
    expect(createOf(html, "welcome.rules_channel_id")).toBeUndefined();
    expect(createOf(html, "core.errors.channel_id")).toBeUndefined();
  });

  it("a page whose answer is unknown, or with no flagged key, is byte-identical to today", () => {
    const keys = ["quotes.channel_id"];
    expect(settingsPage(keys, undefined)).toBe(
      settingsPage(keys, undefined, ""),
    );
    expect(settingsPage(keys, undefined)).not.toContain("&quot;create&quot;");
    expect(settingsPage(["welcome.rules_channel_id"], OK)).toBe(
      settingsPage(["welcome.rules_channel_id"], undefined),
    );
  });

  it("carries the reason when the bot cannot create, so the help line shows", () => {
    expect(
      createOf(settingsPage(["quotes.channel_id"], NO), "quotes.channel_id"),
    ).toEqual(NO);
  });
});

describe("a feature page's settings card", () => {
  const card = (answer: typeof OK | typeof NO | undefined): string =>
    renderFeatureSettingsCard({
      category: "quotes",
      returnTo: "/admin/quotes",
      csrfToken: "t",
      settingRows: [row("quotes.channel_id"), row("welcome.rules_channel_id")],
      pickers: {
        textChannels: TEXT,
        ...(answer ? { createChannel: answer } : {}),
      },
    });

  it("offers the row for the flagged key only", () => {
    const html = card(OK);
    expect(createOf(html, "quotes.channel_id")).toEqual(OK);
    expect(createOf(html, "welcome.rules_channel_id")).toBeUndefined();
  });

  it("without the answer there is no row and no flag", () => {
    expect(card(undefined)).not.toContain("&quot;create&quot;");
  });

  it("draws a refused pending name again as a pending option, keeping the typed name", () => {
    const html = renderFeatureSettingsCard({
      category: "quotes",
      returnTo: "/admin/quotes",
      csrfToken: "t",
      settingRows: [row("quotes.channel_id", "create:Quote Wall")],
      pickers: { textChannels: TEXT, createChannel: OK },
    });
    expect(html).toContain('value="create:Quote Wall" data-create');
    expect(html).toContain("Quote Wall (will be created)");
    expect(html).not.toContain("(unknown)");
  });
});

describe("the page-wide answer", () => {
  const client = {} as Client;
  it("asks once for a text channel and maps the answer", async () => {
    mockCanBotCreate.mockResolvedValueOnce({ ok: true });
    expect(
      await loadCreateChannelAnswer(client, "g", ["x.y", "quotes.channel_id"]),
    ).toEqual(OK);
    expect(mockCanBotCreate).toHaveBeenCalledWith(client, "g", {
      kind: "channel",
    });
  });

  it("carries the help line when the bot lacks the permission", async () => {
    mockCanBotCreate.mockResolvedValueOnce({
      ok: false,
      reason: "The bot needs Manage Channels.",
    });
    expect(
      await loadCreateChannelAnswer(client, "g", ["quotes.channel_id"]),
    ).toEqual(NO);
  });

  it("shows nothing when the permissions cannot be read", async () => {
    mockCanBotCreate.mockResolvedValueOnce({ ok: "unknown" });
    expect(
      await loadCreateChannelAnswer(client, "g", ["quotes.channel_id"]),
    ).toBeUndefined();
  });

  it("does not read the permissions for a page with no flagged key", async () => {
    mockCanBotCreate.mockClear();
    expect(
      await loadCreateChannelAnswer(client, "g", ["welcome.rules_channel_id"]),
    ).toBeUndefined();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });
});
