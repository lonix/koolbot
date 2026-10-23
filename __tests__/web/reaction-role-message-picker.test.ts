/* global Document, HTMLSelectElement, HTMLOptionElement */
/**
 * The welcome roles message picker (#1433): the select over the bot's own
 * reaction-role messages, the labels and the cap, and the shape rule. The
 * markup is read through a DOM, never regular expressions over HTML.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { JSDOM } from "jsdom";

const mockAggregate = jest.fn<(pipeline: unknown[]) => Promise<unknown[]>>();
const mockFind = jest.fn<(q: unknown) => Promise<unknown[]>>();
const mockDistinct =
  jest.fn<(field: string, q: unknown) => Promise<unknown[]>>();
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  REACTION_ROLE_STYLES: ["reaction", "button", "select"],
  REACTION_ROLE_MODES: ["toggle", "sticky", "unique"],
  ReactionRoleConfig: {
    aggregate: mockAggregate,
    distinct: mockDistinct,
    find: mockFind,
  },
}));

const { renderReactionRoleMessageSelect, REACTION_ROLE_MESSAGE_NONE_LABEL } =
  await import("../../src/web/setting-pickers.js");
const {
  REACTION_ROLE_MESSAGE_LIST_CAP,
  buildReactionRoleMessageOptions,
  loadReactionRoleMessageIds,
  loadReactionRoleMessageOptions,
  reactionRoleMessageLabel,
} = await import("../../src/web/reaction-role-messages.js");
const { validateSettingFormat } =
  await import("../../src/utils/setting-formats.js");
const { settingsMetadata } =
  await import("../../src/services/config-schema.js");
const { ChannelType } = await import("discord.js");

const NAME = "value_welcome.roles_message_id";
const A = "100000000000000001";
const B = "100000000000000002";

function doc(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

function selectOf(html: string): HTMLSelectElement {
  const s = doc(html).querySelector("select");
  if (!s) throw new Error("no select");
  return s;
}

function optionsOf(html: string): HTMLOptionElement[] {
  return Array.from(selectOf(html).options);
}

const LOOKUP = {
  names: new Map([["c1", "roles"]]),
  types: new Map([["c1", ChannelType.GuildText]]),
  known: true,
  configuredChannelId: "",
};

describe("the schema entry", () => {
  it("is a picker, not free text", () => {
    expect(settingsMetadata["welcome.roles_message_id"].format).toBe(
      "reaction_role_message",
    );
  });
});

describe("validateSettingFormat reaction_role_message", () => {
  it("accepts empty and a message id, refuses anything else", () => {
    expect(validateSettingFormat("reaction_role_message", "")).toEqual({
      ok: true,
      value: "",
    });
    expect(validateSettingFormat("reaction_role_message", ` ${A} `)).toEqual({
      ok: true,
      value: A,
    });
    for (const bad of ["abc", "123", `${A}x`, "<script>"]) {
      expect(validateSettingFormat("reaction_role_message", bad).ok).toBe(
        false,
      );
    }
  });
});

describe("renderReactionRoleMessageSelect", () => {
  const messages = {
    options: [
      { messageId: A, label: "# roles · 🎮 Gamer" },
      { messageId: B, label: "# roles · 🎨 Artist" },
    ],
    truncated: false,
  };

  it("offers the empty choice first, then each message, with the id as the value", () => {
    const html = renderReactionRoleMessageSelect(NAME, "", { messages });
    const opts = optionsOf(html);
    expect(opts.map((o) => o.value)).toEqual(["", A, B]);
    expect(opts[0].textContent).toBe(REACTION_ROLE_MESSAGE_NONE_LABEL);
    expect(opts[0].selected).toBe(true);
    expect(selectOf(html).name).toBe(NAME);
    expect(selectOf(html).className).toBe("kb-select");
  });

  it("has no text input", () => {
    const html = renderReactionRoleMessageSelect(NAME, "", { messages });
    expect(doc(html).querySelector("input")).toBeNull();
  });

  it("selects the stored message", () => {
    const opts = optionsOf(
      renderReactionRoleMessageSelect(NAME, B, { messages }),
    );
    expect(opts.filter((o) => o.selected).map((o) => o.value)).toEqual([B]);
  });

  it("shows a stored id outside the list as the selected (not found) option and keeps it", () => {
    const stray = "999999999999999999";
    const opts = optionsOf(
      renderReactionRoleMessageSelect(NAME, stray, { messages }),
    );
    expect(opts.map((o) => o.value)).toEqual(["", stray, A, B]);
    const sel = opts.find((o) => o.selected);
    expect(sel?.value).toBe(stray);
    expect(sel?.textContent).toBe(`${stray} (not found)`);
  });

  it("with no messages keeps the stored value and points at the Reaction Roles page", () => {
    const html = renderReactionRoleMessageSelect(NAME, A, {
      messages: { options: [], truncated: false },
    });
    expect(optionsOf(html).map((o) => o.value)).toEqual(["", A]);
    const link = doc(html).querySelector("a");
    expect(link?.getAttribute("href")).toBe("/admin/reaction-roles");
    expect(html).toContain("no reaction-role messages yet");
  });

  it("says so, and keeps the stored value, when the list could not be read", () => {
    const html = renderReactionRoleMessageSelect(NAME, A, { messages: null });
    const sel = optionsOf(html).find((o) => o.selected);
    expect(sel?.value).toBe(A);
    expect(sel?.textContent).toBe(`${A} (could not check)`);
    expect(html).toContain("could not be read");
    expect(html).not.toContain("no reaction-role messages yet");
    expect(doc(html).querySelector("a")).toBeNull();
  });

  it("round-trips a stored id with surrounding spaces unchanged", () => {
    const padded = ` ${A} `;
    for (const messages of [
      {
        options: [{ messageId: A, label: "# roles · 🎮 Gamer" }],
        truncated: false,
      },
      { options: [], truncated: false },
      null,
    ]) {
      const html = renderReactionRoleMessageSelect(NAME, padded, { messages });
      const sel = optionsOf(html).filter((o) => o.selected);
      expect(sel).toHaveLength(1);
      // What the browser would post for the untouched select.
      expect(sel[0].value).toBe(padded);
      expect(selectOf(html).value).toBe(padded);
    }
  });

  it("says that the list is cut when it is", () => {
    const html = renderReactionRoleMessageSelect(NAME, "", {
      messages: { ...messages, truncated: true },
    });
    expect(html).toContain("Showing the 2 newest");
  });

  it("never disables an option, even in a locked control", () => {
    const html = renderReactionRoleMessageSelect(NAME, "999999999999999999", {
      messages,
      disabled: true,
    });
    expect(optionsOf(html).some((o) => o.disabled)).toBe(false);
    expect(selectOf(html).disabled).toBe(true);
    expect(selectOf(html).hasAttribute("data-dep-locked")).toBe(true);
  });

  it("escapes labels and carries the accessibility attributes", () => {
    const html = renderReactionRoleMessageSelect(NAME, "", {
      id: "x-id",
      describedBy: "x-help",
      invalid: true,
      describedByBase: "x-help",
      messages: {
        options: [{ messageId: A, label: '<img src=x onerror="1"> & co' }],
        truncated: false,
      },
    });
    expect(html).not.toContain("<img");
    expect(selectOf(html).id).toBe("x-id");
    expect(selectOf(html).getAttribute("aria-describedby")).toBe("x-help");
    expect(selectOf(html).getAttribute("aria-invalid")).toBe("true");
    expect(optionsOf(html)[1].textContent).toBe('<img src=x onerror="1"> & co');
  });
});

describe("reactionRoleMessageLabel", () => {
  it("names the channel and up to three roles, then +N", () => {
    const label = reactionRoleMessageLabel(
      {
        messageId: A,
        messageChannelId: "c1",
        roles: [
          { emoji: "🎮", roleName: "Gamer" },
          { emoji: "🎨", roleName: "Artist" },
          { emoji: "📚", roleName: "Reader" },
          { emoji: "🎲", roleName: "Roller" },
          { emoji: "🎵", roleName: "Singer" },
        ],
      },
      LOOKUP,
    );
    expect(label).toBe("# roles · 🎮 Gamer, 🎨 Artist, 📚 Reader +2");
  });

  it("shows a channel the guild no longer has as unavailable, without a Discord call", () => {
    const label = reactionRoleMessageLabel(
      {
        messageId: A,
        messageChannelId: "gone",
        roles: [{ emoji: "🎮", roleName: "Gamer" }],
      },
      LOOKUP,
    );
    expect(label).toContain("gone (unavailable)");
  });

  it("does not call a channel deleted when the channel list was not read", () => {
    const label = reactionRoleMessageLabel(
      { messageId: A, messageChannelId: "c9", roles: [] },
      { ...LOOKUP, known: false },
    );
    expect(label).toBe("# c9 · no roles");
  });

  it("falls back to the configured channel for a legacy row and skips custom emoji markup", () => {
    const label = reactionRoleMessageLabel(
      {
        messageId: A,
        messageChannelId: null,
        roles: [{ emoji: "<:x:123456789012345678>", roleName: "Custom" }],
      },
      { ...LOOKUP, configuredChannelId: "c1" },
    );
    expect(label).toBe("# roles · Custom");
  });

  it("is cut to a sensible length", () => {
    const label = reactionRoleMessageLabel(
      {
        messageId: A,
        messageChannelId: "c1",
        roles: [{ emoji: "", roleName: "R".repeat(300) }],
      },
      LOOKUP,
    );
    expect(Array.from(label).length).toBe(100);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("buildReactionRoleMessageOptions", () => {
  const groups = Array.from(
    { length: REACTION_ROLE_MESSAGE_LIST_CAP + 1 },
    (_, i) => ({
      messageId: String(100000000000000000 + i),
      messageChannelId: "c1",
      roles: [{ emoji: "", roleName: `Role ${i}` }],
    }),
  );

  it("caps the list and reports that it was cut", () => {
    const r = buildReactionRoleMessageOptions(groups, LOOKUP);
    expect(r.options).toHaveLength(REACTION_ROLE_MESSAGE_LIST_CAP);
    expect(r.truncated).toBe(true);
  });

  it("does not report a cut at the cap exactly", () => {
    const r = buildReactionRoleMessageOptions(groups.slice(0, 50), LOOKUP);
    expect(r.truncated).toBe(false);
  });
});

describe("loading from the stored mappings", () => {
  beforeEach(() => {
    mockAggregate.mockReset();
    mockDistinct.mockReset();
    mockFind.mockReset();
  });

  it("builds the set from this guild's active messages only", async () => {
    mockDistinct.mockResolvedValue([A, B, "", 5]);
    const ids = await loadReactionRoleMessageIds("guild-1");
    expect([...ids]).toEqual([A, B]);
    expect(mockDistinct).toHaveBeenCalledWith("messageId", {
      guildId: "guild-1",
      isArchived: false,
    });
  });

  it("rejects when the read fails, so a save is refused", async () => {
    mockDistinct.mockRejectedValue(new Error("down"));
    await expect(loadReactionRoleMessageIds("guild-1")).rejects.toThrow("down");
  });

  it("matches the guild and skips archived rows", async () => {
    mockAggregate.mockResolvedValue([
      {
        _id: A,
        messageChannelId: "c1",
        roles: [{ emoji: "🎮", roleName: "G" }],
      },
    ]);
    const r = await loadReactionRoleMessageOptions("guild-1", LOOKUP);
    expect(r?.options).toEqual([{ messageId: A, label: "# roles · 🎮 G" }]);
    const pipeline = mockAggregate.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(pipeline[0]).toEqual({
      $match: { guildId: "guild-1", isArchived: false },
    });
    // The cut happens after sorting by message id, never in the pipeline.
    expect(pipeline.some((st) => "$limit" in st)).toBe(false);
  });

  it("sorts by the message's own age, so a restored message with an old createdAt is inside the cap", async () => {
    const restored = "900000000000000000";
    const rows = Array.from(
      { length: REACTION_ROLE_MESSAGE_LIST_CAP },
      (_, i) => ({
        _id: String(100000000000000100n + BigInt(i)),
        messageChannelId: "c1",
        roles: [{ emoji: "", roleName: `R${i}` }],
      }),
    );
    // The aggregate hands the groups back in mapping order: the restored
    // message's mapping is the oldest, so it comes first, not last.
    mockAggregate.mockResolvedValue([
      {
        _id: restored,
        messageChannelId: "c1",
        roles: [{ emoji: "", roleName: "Restored" }],
      },
      ...rows,
    ]);
    const r = await loadReactionRoleMessageOptions("guild-1", LOOKUP);
    expect(r?.options).toHaveLength(REACTION_ROLE_MESSAGE_LIST_CAP);
    expect(r?.options[0].messageId).toBe(restored);
    expect(r?.truncated).toBe(true);
    expect(r?.options.map((o) => o.messageId)).not.toContain(rows[0]._id);
  });

  it("does not throw on a malformed message id, and lists it last", async () => {
    mockAggregate.mockResolvedValue([
      { _id: "not-a-snowflake", messageChannelId: "c1", roles: [] },
      { _id: "", messageChannelId: "c1", roles: [] },
      { _id: A, messageChannelId: "c1", roles: [] },
      { _id: B, messageChannelId: "c1", roles: [] },
    ]);
    const r = await loadReactionRoleMessageOptions("guild-1", LOOKUP);
    expect(r?.options.map((o) => o.messageId)).toEqual([
      B,
      A,
      "",
      "not-a-snowflake",
    ]);
  });

  it("takes the picker channel from any mapping, an archived sibling included, when no active one records it", async () => {
    mockAggregate.mockResolvedValue([
      { _id: A, roles: [{ emoji: "🎮", roleName: "G" }] },
      { _id: B, messageChannelId: "c1", roles: [] },
    ]);
    mockFind.mockResolvedValue([{ messageId: A, messageChannelId: "c1" }]);
    const r = await loadReactionRoleMessageOptions("guild-1", {
      ...LOOKUP,
      configuredChannelId: "other",
    });
    expect(r?.options.find((o) => o.messageId === A)?.label).toBe(
      "# roles · 🎮 G",
    );
    // One batched, guild-scoped query for the messages that lack a channel,
    // with no isArchived filter (the service's pickerChannelForMessage rule).
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledWith({
      guildId: "guild-1",
      messageId: { $in: [A] },
      messageChannelId: { $exists: true, $ne: "" },
    });
    const group = (
      mockAggregate.mock.calls[0][0] as Array<Record<string, any>>
    ).find((st) => st.$group)?.$group;
    expect(group.messageChannelId).toEqual({ $max: "$messageChannelId" });
  });

  it("falls back to the configured channel when no mapping knows one, or the sibling lookup fails", async () => {
    mockAggregate.mockResolvedValue([{ _id: A, roles: [] }]);
    mockFind.mockRejectedValue(new Error("down"));
    const r = await loadReactionRoleMessageOptions("guild-1", {
      ...LOOKUP,
      configuredChannelId: "c1",
    });
    expect(r?.options[0].label).toBe("# roles · no roles");
  });

  it("returns null, not an empty list, when the read fails", async () => {
    mockAggregate.mockRejectedValue(new Error("down"));
    expect(await loadReactionRoleMessageOptions("guild-1", LOOKUP)).toBeNull();
  });
});
