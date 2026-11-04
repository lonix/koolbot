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

const {
  renderSettingsPage,
  renderFeatureSettingsCard,
  renderReactionRolesPage,
  renderNoticesPage,
} = await import("../../src/web/admin-views.js");
type SettingRow = import("../../src/web/admin-views.js").SettingRow;
const { loadCreateChannelAnswer } =
  await import("../../src/web/setting-create-load.js");
const {
  pickerCreateFor,
  offersCreateChannel,
  offersCreateCategory,
  createKindOf,
  createdNote,
} = await import("../../src/web/setting-create.js");
const { loadCreateCategoryAnswer } =
  await import("../../src/web/setting-create-load.js");

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

describe("the Reaction roles and Notices pages forward the answer to their card", () => {
  const COMMON = { csrfToken: "t", remainingMs: 900_000 };
  const channel = { name: "c", id: "1", type: ChannelType.GuildText };
  const reactionRoles = (key: string, answer?: typeof OK | typeof NO): string =>
    renderReactionRolesPage({
      ...COMMON,
      enabled: true,
      configChannel: channel,
      active: [],
      archived: [],
      settingRows: [row(key)],
      textChannels: TEXT,
      roles: [],
      messages: null,
      ...(answer ? { createChannel: answer } : {}),
    } as unknown as Parameters<typeof renderReactionRolesPage>[0]);
  const notices = (key: string, answer?: typeof OK | typeof NO): string =>
    renderNoticesPage({
      ...COMMON,
      enabled: true,
      channel,
      total: 0,
      textChannels: TEXT,
      settingRows: [row(key)],
      groups: [],
      categoryOptions: [],
      ...(answer ? { createChannel: answer } : {}),
    } as unknown as Parameters<typeof renderNoticesPage>[0]);

  for (const [name, render, key] of [
    ["Reaction roles", reactionRoles, "reactionroles.message_channel_id"],
    ["Notices", notices, "notices.channel_id"],
  ] as const) {
    it(`${name}: the row is offered when the bot can create`, () => {
      expect(createOf(render(key, OK), key)).toEqual(OK);
    });
    it(`${name}: the help line shows when the bot cannot create`, () => {
      expect(createOf(render(key, NO), key)).toEqual(NO);
    });
    it(`${name}: no row when the flag is missing or the answer is unknown`, () => {
      expect(render(key)).not.toContain("&quot;create&quot;");
      expect(render("welcome.rules_channel_id", OK)).not.toContain(
        "&quot;create&quot;",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// The category kind (#1664).
// ---------------------------------------------------------------------------

const CATS = [
  {
    id: "20",
    name: "Staff",
    type: ChannelType.GuildCategory,
    parentName: null,
  },
];
const catRow = (key: string, current = ""): SettingRow =>
  ({
    key,
    label: key,
    current,
    defaultValue: "",
    type: "category",
    description: "d",
    category: key.split(".")[0],
  }) as SettingRow;
const CAT_OK = { kind: "category" as const, ok: true };
const CAT_NO = {
  kind: "category" as const,
  ok: false,
  reason: "The bot needs Manage Channels to create a category.",
};
const CAT_KEYS = [
  "voicechannels.category_id",
  "events.category_id",
  "tickets.category_id",
];

describe("which settings offer the category row (#1664)", () => {
  it("only the three flagged category settings, from the schema", () => {
    for (const k of CAT_KEYS) {
      expect(offersCreateCategory(k)).toBe(true);
      expect(createKindOf(k)).toBe("category");
      // The text flag is separate: a category setting is never a text one.
      expect(offersCreateChannel(k)).toBe(false);
    }
    expect(offersCreateCategory("quotes.channel_id")).toBe(false);
    expect(createKindOf("quotes.channel_id")).toBe("text");
    expect(createKindOf("voicechannels.lobby.channel_id")).toBeNull();
    expect(createKindOf("quotes.max_length")).toBeNull();
  });

  it("pickerCreateFor gives each kind its own answer and a row of the other kind nothing", () => {
    const f = pickerCreateFor(OK, CAT_OK) as (r: {
      key: string;
      type: string;
    }) => unknown;
    expect(f({ key: "quotes.channel_id", type: "channel" })).toEqual(OK);
    expect(f({ key: "tickets.category_id", type: "category" })).toEqual(CAT_OK);
    expect(
      f({ key: "welcome.rules_channel_id", type: "channel" }),
    ).toBeUndefined();
    // Only the category answer: a text row gets nothing.
    const g = pickerCreateFor(undefined, CAT_OK) as typeof f;
    expect(g({ key: "quotes.channel_id", type: "channel" })).toBeUndefined();
    expect(g({ key: "tickets.category_id", type: "category" })).toEqual(CAT_OK);
    expect(pickerCreateFor(undefined, undefined)).toBeUndefined();
  });
});

describe("the Settings page and the card draw the category row (#1664)", () => {
  const page = (
    answer: typeof CAT_OK | typeof CAT_NO | undefined,
    current = "",
  ): string =>
    renderSettingsPage({
      csrfToken: "t",
      guildId: "g",
      guildName: "G",
      flash: null,
      groups: [
        { category: "x", rows: CAT_KEYS.map((k) => catRow(k, current)) },
      ],
      textChannels: TEXT,
      voiceChannels: [],
      categoryChannels: CATS,
      roles: [],
      pickerCreate: pickerCreateFor(undefined, answer),
    } as unknown as Parameters<typeof renderSettingsPage>[0]);

  it("flags every category setting with the category kind", () => {
    const html = page(CAT_OK);
    for (const k of CAT_KEYS) expect(createOf(html, k)).toEqual(CAT_OK);
  });

  it("carries the help line when the bot cannot create", () => {
    const html = page(CAT_NO);
    for (const k of CAT_KEYS) expect(createOf(html, k)).toEqual(CAT_NO);
  });

  it("is byte-identical to today when the answer is unknown (no row, no help line)", () => {
    expect(page(undefined)).not.toContain("&quot;create&quot;");
  });

  it("draws a refused pending name again as a pending option, keeping the typed name", () => {
    const html = page(CAT_OK, "create:Gaming Voice");
    expect(html).toContain('value="create:Gaming Voice" data-create');
    expect(html).toContain("Gaming Voice (will be created)");
    expect(html).not.toContain("(unavailable)");
  });

  it("the card offers it for a category key, and not for a text key beside it", () => {
    const html = renderFeatureSettingsCard({
      category: "events",
      returnTo: "/admin/events",
      csrfToken: "t",
      settingRows: [
        catRow("events.category_id"),
        row("events.announcement_channel_id"),
      ],
      pickers: {
        textChannels: TEXT,
        categoryChannels: CATS,
        createChannel: OK,
        createCategory: CAT_OK,
      },
    });
    expect(createOf(html, "events.category_id")).toEqual(CAT_OK);
    expect(createOf(html, "events.announcement_channel_id")).toEqual(OK);
  });

  it("the card without the category answer leaves the category picker plain", () => {
    const html = renderFeatureSettingsCard({
      category: "tickets",
      returnTo: "/admin/tickets",
      csrfToken: "t",
      settingRows: [catRow("tickets.category_id")],
      pickers: { categoryChannels: CATS, createChannel: OK },
    });
    expect(html).not.toContain("&quot;create&quot;");
  });
});

describe("the page-wide category answer (#1664)", () => {
  const client = {} as Client;
  it("asks once for a category and maps the answer", async () => {
    mockCanBotCreate.mockResolvedValueOnce({ ok: true });
    expect(
      await loadCreateCategoryAnswer(client, "g", [
        "x.y",
        "tickets.category_id",
      ]),
    ).toEqual(CAT_OK);
    expect(mockCanBotCreate).toHaveBeenLastCalledWith(client, "g", {
      kind: "category",
    });
  });

  it("carries the help line, and nothing for an unreadable answer", async () => {
    mockCanBotCreate.mockResolvedValueOnce({
      ok: false,
      reason: CAT_NO.reason,
    });
    expect(
      await loadCreateCategoryAnswer(client, "g", ["tickets.category_id"]),
    ).toEqual(CAT_NO);
    mockCanBotCreate.mockResolvedValueOnce({ ok: "unknown" });
    expect(
      await loadCreateCategoryAnswer(client, "g", ["tickets.category_id"]),
    ).toBeUndefined();
  });

  it("does not read the permissions for a page with no category setting", async () => {
    mockCanBotCreate.mockClear();
    expect(
      await loadCreateCategoryAnswer(client, "g", ["quotes.channel_id"]),
    ).toBeUndefined();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });
});

describe("the flash names a category (#1664)", () => {
  it("says category, with its glyph, for a created and for a selected one", () => {
    const label = (k: string): string => k;
    expect(
      createdNote(
        [
          {
            key: "tickets.category_id",
            id: "1",
            name: "Support",
            created: true,
            kind: "category",
          },
        ],
        label,
      ),
    ).toBe(" Created category 📁 Support for tickets.category_id.");
    expect(
      createdNote(
        [
          {
            key: "tickets.category_id",
            id: "1",
            name: "Support",
            created: false,
            kind: "category",
          },
        ],
        label,
      ),
    ).toBe(" Used the existing category 📁 Support for tickets.category_id.");
    // A text channel is worded as before.
    expect(
      createdNote([{ key: "a", id: "1", name: "wall", created: true }], label),
    ).toBe(" Created # wall for a.");
  });
});
