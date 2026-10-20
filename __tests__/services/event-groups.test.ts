import { describe, it, expect } from "@jest/globals";
import {
  CHANNEL_LEAD_MAX,
  GROUP_COUNT_HARD_MAX,
  GROUP_NAME_MAX,
  GROUP_TAG_MAX,
  MIN_NICKNAME_ROOM,
  NICKNAME_MAX,
  TAG_DECORATION_LENGTH,
  captainsLobbyName,
  copyGroupSetup,
  effectiveChannelLeadMinutes,
  emptyGroupSetup,
  hasCaptainsLobby,
  parseGroupForm,
  readSeriesGroupSetup,
  resolveGroupCountLimits,
  seriesGroupSetupOf,
  successorGroupFields,
  validateGroupSetup,
  type GroupSetupInput,
  type RawGroupRow,
  validateLeaderLabel,
} from "../../src/services/event-groups.js";

function row(position: number, extra: Partial<RawGroupRow> = {}): RawGroupRow {
  return {
    position,
    name: `Group ${position}`,
    kind: "team",
    size: "",
    tag: "",
    marker: "",
    ...extra,
  };
}

function input(extra: Partial<GroupSetupInput> = {}): GroupSetupInput {
  return {
    enabled: true,
    presetId: "",
    groupLabel: "",
    leaderLabel: "",
    channelLeadMinutes: "",
    rows: [row(1), row(2)],
    ...extra,
  };
}

function errorsOf(i: GroupSetupInput, maxCount = 15): string[] {
  const result = validateGroupSetup(i, { maxCount });
  if (result.ok) throw new Error("expected validation errors");
  return result.errors;
}

describe("validateGroupSetup", () => {
  it("returns the empty setup when groups are switched off, whatever else was posted", () => {
    const result = validateGroupSetup(
      input({ enabled: false, rows: [row(1, { name: "x".repeat(500) })] }),
      { maxCount: 15 },
    );
    expect(result).toEqual({ ok: true, setup: emptyGroupSetup() });
  });

  it("builds a Custom setup with defaults, stable keys and no members", () => {
    const result = validateGroupSetup(input(), { maxCount: 15 });
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.setup).toMatchObject({
      groupsEnabled: true,
      presetId: null,
      groupLabel: "Team",
      leaderLabel: "Leader",
      channelLeadMinutes: null,
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      tagsEnabled: false,
    });
    expect(result.setup.groups).toHaveLength(2);
    const keys = result.setup.groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(2);
    for (const g of result.setup.groups) {
      expect(g).toMatchObject({
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      });
    }
  });

  it("derives keys independently of the names", () => {
    const a = validateGroupSetup(input(), { maxCount: 15 });
    const b = validateGroupSetup(input(), { maxCount: 15 });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.setup.groups[0].key).not.toBe(b.setup.groups[0].key);
    expect(a.setup.groups[0].key).not.toContain("Group");
  });

  it("covers the clan match: five squads with different sizes and a lead time", () => {
    const result = validateGroupSetup(
      input({
        groupLabel: "Squad",
        channelLeadMinutes: "30",
        rows: [
          row(1, { name: "Assault Squad", size: "8" }),
          row(2, { name: "Logi", size: "4" }),
          row(3, { name: "Heli", size: "2" }),
          row(4, { name: "FOB", size: "6" }),
          row(5, { name: "Spec Ops", size: "5" }),
          row(6, { name: "Command", kind: "leads" }),
        ],
      }),
      { maxCount: 15 },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.setup.channelLeadMinutes).toBe(30);
    expect(result.setup.groupLabel).toBe("Squad");
    expect(result.setup.groups.map((g) => g.size)).toEqual([
      8,
      4,
      2,
      6,
      5,
      null,
    ]);
    expect(result.setup.groups[5].kind).toBe("leads");
  });

  it("uses a preset's groups and label when no rows were typed", () => {
    const result = validateGroupSetup(
      input({ presetId: "builtin:wardogs", rows: [] }),
      { maxCount: 15 },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.setup.presetId).toBe("builtin:wardogs");
    expect(result.setup.groups.map((g) => [g.name, g.marker])).toEqual([
      ["Manticore", "🟢"],
      ["Valkyra", "🔴"],
      ["Lonestar", "🔵"],
    ]);
  });

  it("lets typed rows win over the preset but records the preset id", () => {
    const result = validateGroupSetup(
      input({ presetId: "builtin:wardogs", rows: [row(1, { name: "Mine" })] }),
      { maxCount: 15 },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.setup.groups.map((g) => g.name)).toEqual(["Mine"]);
    expect(result.setup.presetId).toBe("builtin:wardogs");
  });

  it("rejects an unknown preset, and treats 'custom' as Custom", () => {
    expect(errorsOf(input({ presetId: "builtin:nope" }))[0]).toMatch(
      /^Unknown group preset: it does not exist or was deleted/,
    );
    const custom = validateGroupSetup(input({ presetId: "custom" }), {
      maxCount: 15,
    });
    expect(custom.ok && custom.setup.presetId).toBeNull();
  });

  it("requires at least one group", () => {
    expect(errorsOf(input({ rows: [] }))[0]).toMatch(/at least one group/);
  });

  it("caps the number of groups at the configured maximum", () => {
    const rows = [row(1), row(2), row(3)];
    expect(errorsOf(input({ rows }), 2)[0]).toMatch(/at most 2 groups/);
  });

  it("never allows more than the hard maximum, whatever the config says", () => {
    const rows = Array.from({ length: GROUP_COUNT_HARD_MAX + 1 }, (_, i) =>
      row(i + 1),
    );
    expect(errorsOf(input({ rows }), 500)[0]).toMatch(
      new RegExp(`at most ${GROUP_COUNT_HARD_MAX} groups`),
    );
  });

  it("names the row and field in each error and reports them all", () => {
    const errors = errorsOf(
      input({
        rows: [
          row(1, { name: "", size: "5" }),
          row(2, { name: "x".repeat(GROUP_NAME_MAX + 1) }),
          row(3, { size: "100" }),
          row(4, { tag: "TOOLONGTAG" }),
          row(5, { kind: "boss" }),
        ],
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Group 1 name:/),
        expect.stringMatching(/^Group 2 name: at most 50/),
        expect.stringMatching(/^Group 3 size:/),
        expect.stringMatching(/^Group 4 tag:/),
        expect.stringMatching(/^Group 5 kind:/),
      ]),
    );
  });

  it.each(["0", "100", "-1", "1.5", "abc", "1e2", "0x10"])(
    "rejects the size %s",
    (size) => {
      expect(errorsOf(input({ rows: [row(1, { size })] }))[0]).toMatch(
        /^Group 1 size:/,
      );
    },
  );

  it.each([
    ["1", 1],
    ["99", 99],
    ["", null],
  ])("accepts the size %s", (size, expected) => {
    const result = validateGroupSetup(input({ rows: [row(1, { size })] }), {
      maxCount: 15,
    });
    expect(result.ok && result.setup.groups[0].size).toBe(expected);
  });

  it("rejects duplicate names within an event, ignoring case and spacing", () => {
    const errors = errorsOf(
      input({
        rows: [row(1, { name: "Red Team" }), row(2, { name: " red   TEAM " })],
      }),
    );
    expect(errors[0]).toMatch(/^Group 2 name: .* already used by group 1/);
  });

  it("allows at most one leads group", () => {
    const errors = errorsOf(
      input({
        rows: [
          row(1, { kind: "leads" }),
          row(2),
          row(3, { name: "Other", kind: "leads" }),
        ],
      }),
    );
    expect(errors).toEqual([
      expect.stringMatching(/^Group 3 kind: only one leads group/),
    ]);
  });

  it("keeps a tag short enough to leave room for a nickname", () => {
    expect(MIN_NICKNAME_ROOM).toBe(
      NICKNAME_MAX - (GROUP_TAG_MAX + TAG_DECORATION_LENGTH),
    );
    expect(MIN_NICKNAME_ROOM).toBeGreaterThanOrEqual(16);
    const ok = validateGroupSetup(
      input({ rows: [row(1, { tag: "x".repeat(GROUP_TAG_MAX) })] }),
      { maxCount: 15 },
    );
    expect(ok.ok).toBe(true);
    expect(
      errorsOf(
        input({ rows: [row(1, { tag: "x".repeat(GROUP_TAG_MAX + 1) })] }),
      ),
    ).toHaveLength(1);
  });

  it("rejects control characters in names, tags and markers", () => {
    expect(
      errorsOf(input({ rows: [row(1, { name: "Bad\u0007name" })] }))[0],
    ).toMatch(/control characters/);
    expect(errorsOf(input({ rows: [row(1, { tag: "A\u0000B" })] }))[0]).toMatch(
      /control characters/,
    );
    expect(
      errorsOf(input({ rows: [row(1, { marker: "\u0001" })] }))[0],
    ).toMatch(/control characters/);
  });

  it("limits the marker to a few characters", () => {
    expect(errorsOf(input({ rows: [row(1, { marker: "abcde" })] }))[0]).toMatch(
      /^Group 1 marker:/,
    );
    const emoji = validateGroupSetup(
      input({ rows: [row(1, { marker: "🟢" })] }),
      { maxCount: 15 },
    );
    expect(emoji.ok).toBe(true);
  });

  it("collapses whitespace in names", () => {
    const result = validateGroupSetup(
      input({ rows: [row(1, { name: "  Red \n  Team ", tag: " AB " })] }),
      { maxCount: 15 },
    );
    expect(result.ok && result.setup.groups[0].name).toBe("Red Team");
    expect(result.ok && result.setup.groups[0].tag).toBe("AB");
  });

  it.each(["-1", "1441", "abc", "1.5", "99999"])(
    "rejects the channel creation time %s",
    (value) => {
      expect(errorsOf(input({ channelLeadMinutes: value }))[0]).toMatch(
        /Channel creation time/,
      );
    },
  );

  it.each([
    ["0", 0],
    [String(CHANNEL_LEAD_MAX), CHANNEL_LEAD_MAX],
    ["", null],
  ])("accepts the channel creation time %j", (value, expected) => {
    const result = validateGroupSetup(input({ channelLeadMinutes: value }), {
      maxCount: 15,
    });
    expect(result.ok && result.setup.channelLeadMinutes).toBe(expected);
  });

  it("limits the group and leader labels", () => {
    expect(errorsOf(input({ groupLabel: "x".repeat(21) }))[0]).toMatch(
      /^Group label:/,
    );
    expect(errorsOf(input({ leaderLabel: "x".repeat(21) }))[0]).toMatch(
      /^Leader label:/,
    );
  });
});

describe("group leaders on the event form (#1195)", () => {
  it("are off unless the form switched them on, and only with groups on", () => {
    const off = validateGroupSetup(input(), { maxCount: 15 });
    expect(off.ok && off.setup.captainsEnabled).toBe(false);
    const on = validateGroupSetup(input({ captainsEnabled: true }), {
      maxCount: 15,
    });
    expect(on.ok && on.setup.captainsEnabled).toBe(true);
    // Groups off: the empty setup, whatever else was posted.
    const plain = validateGroupSetup(
      input({ enabled: false, captainsEnabled: true }),
      { maxCount: 15 },
    );
    expect(plain.ok && plain.setup.captainsEnabled).toBe(false);
  });

  it("are read from the leaders checkbox", () => {
    expect(parseGroupForm({ groups_enabled: "1" }).captainsEnabled).toBe(false);
    expect(
      parseGroupForm({ groups_enabled: "1", groups_captains: "1" })
        .captainsEnabled,
    ).toBe(true);
    expect(
      parseGroupForm({ groups_captains: ["1", "1"] }).captainsEnabled,
    ).toBe(false);
  });

  it("a preset's groups never switch them on", () => {
    const result = validateGroupSetup(
      input({ presetId: "builtin:wardogs", rows: [] }),
      { maxCount: 15 },
    );
    expect(result.ok && result.setup.captainsEnabled).toBe(false);
  });

  it("the next occurrence of a series keeps the switch but not the leaders", () => {
    const copy = copyGroupSetup({
      groupsEnabled: true,
      captainsEnabled: true,
      groups: [{ key: "g_1", name: "A", kind: "team", captainId: "u9" }],
    });
    expect(copy.captainsEnabled).toBe(true);
    expect(copy.groups[0].captainId).toBeNull();
  });
});

describe("clan tags on the event form (#1194)", () => {
  it("are off unless the form switched them on, the suffix only with them, and only with groups on", () => {
    const off = validateGroupSetup(input(), { maxCount: 15 });
    expect(off.ok && [off.setup.tagsEnabled, off.setup.tagsSuffix]).toEqual([
      false,
      false,
    ]);
    const on = validateGroupSetup(input({ tagsEnabled: true }), {
      maxCount: 15,
    });
    expect(on.ok && [on.setup.tagsEnabled, on.setup.tagsSuffix]).toEqual([
      true,
      false,
    ]);
    const suffix = validateGroupSetup(
      input({ tagsEnabled: true, tagsSuffix: true }),
      { maxCount: 15 },
    );
    expect(suffix.ok && suffix.setup.tagsSuffix).toBe(true);
    // A suffix with tags off means nothing.
    const stray = validateGroupSetup(input({ tagsSuffix: true }), {
      maxCount: 15,
    });
    expect(stray.ok && stray.setup.tagsSuffix).toBe(false);
    // Groups off: the empty setup, whatever else was posted.
    const plain = validateGroupSetup(
      input({ enabled: false, tagsEnabled: true, tagsSuffix: true }),
      { maxCount: 15 },
    );
    expect(
      plain.ok && [plain.setup.tagsEnabled, plain.setup.tagsSuffix],
    ).toEqual([false, false]);
  });

  it("are read from the two checkboxes", () => {
    const none = parseGroupForm({ groups_enabled: "1" });
    expect([none.tagsEnabled, none.tagsSuffix]).toEqual([false, false]);
    const both = parseGroupForm({
      groups_enabled: "1",
      groups_tags: "1",
      groups_tags_suffix: "1",
    });
    expect([both.tagsEnabled, both.tagsSuffix]).toEqual([true, true]);
  });

  it("a preset chosen on the server never switches them on by itself", () => {
    const result = validateGroupSetup(
      input({ presetId: "builtin:wardogs", rows: [] }),
      { maxCount: 15 },
    );
    expect(result.ok && result.setup.tagsEnabled).toBe(false);
  });

  it("the next occurrence of a series keeps the toggle and the format", () => {
    const copy = copyGroupSetup({
      groupsEnabled: true,
      tagsEnabled: true,
      tagsSuffix: true,
      groups: [],
    });
    expect([copy.tagsEnabled, copy.tagsSuffix]).toEqual([true, true]);
    expect(copyGroupSetup({ groupsEnabled: true }).tagsSuffix).toBe(false);
  });
});

describe("validateLeaderLabel", () => {
  it("takes a name, collapses spaces, defaults an empty one and refuses a bad one", () => {
    expect(validateLeaderLabel("  Squad   Lead ")).toEqual({
      ok: true,
      value: "Squad Lead",
    });
    expect(validateLeaderLabel("")).toEqual({ ok: true, value: "Leader" });
    expect(validateLeaderLabel("x".repeat(21))).toMatchObject({ ok: false });
    expect(validateLeaderLabel("bad\u0007")).toMatchObject({ ok: false });
  });
});

describe("validateGroupSetup keys on re-validation", () => {
  it("keeps a well-formed key so an edit does not change a group's identity", () => {
    const result = validateGroupSetup(
      input({
        rows: [
          row(1, { key: "g_0123abcd" }),
          row(2, { key: "g_deadbeef" }),
          row(3),
        ],
      }),
      { maxCount: 15 },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    const keys = result.setup.groups.map((g) => g.key);
    expect(keys.slice(0, 2)).toEqual(["g_0123abcd", "g_deadbeef"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("mints a new key for a malformed or repeated one", () => {
    const result = validateGroupSetup(
      input({
        rows: [
          row(1, { key: "g_0123abcd" }),
          row(2, { key: "g_0123abcd" }),
          row(3, { key: "not a key" }),
        ],
      }),
      { maxCount: 15 },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    const keys = result.setup.groups.map((g) => g.key);
    expect(keys[0]).toBe("g_0123abcd");
    expect(keys[1]).not.toBe("g_0123abcd");
    expect(keys[2]).toMatch(/^g_[0-9a-f]{8}$/);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("parseGroupForm", () => {
  it("reads the flat indexed fields, skips blank rows and keeps the form position", () => {
    const parsed = parseGroupForm({
      groups_enabled: "1",
      groups_preset: "builtin:wardogs",
      groups_label: " Squad ",
      groups_leader_label: "Captain",
      groups_lead_minutes: "30",
      group_0_name: "Alpha",
      group_0_kind: "team",
      group_1_name: "",
      group_1_kind: "team",
      group_2_name: "Spectators",
      group_2_kind: "open",
      group_2_size: " 4 ",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.presetId).toBe("builtin:wardogs");
    expect(parsed.groupLabel).toBe("Squad");
    expect(parsed.channelLeadMinutes).toBe("30");
    expect(
      parsed.rows.map((r) => [r.position, r.name, r.kind, r.size]),
    ).toEqual([
      [1, "Alpha", "team", ""],
      [3, "Spectators", "open", "4"],
    ]);
  });

  it("treats an absent or non-string section as off with no rows", () => {
    expect(parseGroupForm(undefined)).toMatchObject({
      enabled: false,
      rows: [],
    });
    expect(
      parseGroupForm({ groups_enabled: ["1", "1"], group_0_name: ["a", "b"] }),
    ).toMatchObject({ enabled: false, rows: [] });
  });

  it("ignores rows beyond the form's range", () => {
    expect(parseGroupForm({ group_100_name: "late" }).rows).toEqual([]);
  });
});

describe("copyGroupSetup", () => {
  it("returns the empty setup for an event from before groups", () => {
    expect(copyGroupSetup({})).toEqual(emptyGroupSetup());
    expect(copyGroupSetup({ groups: null, groupsEnabled: null })).toEqual(
      emptyGroupSetup(),
    );
  });

  it("keeps the setup and keys but resets members, captains and channels", () => {
    const copy = copyGroupSetup({
      groupsEnabled: true,
      presetId: "builtin:wardogs",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      channelLeadMinutes: 0,
      tagsEnabled: true,
      groups: [
        {
          key: "g_1",
          name: "Manticore",
          kind: "team",
          size: 6,
          tag: "MAN",
          marker: "🟢",
          channelId: "c1",
          captainId: "u9",
          memberIds: ["u1"],
        },
      ],
    });
    expect(copy.channelLeadMinutes).toBe(0);
    expect(copy.tagsEnabled).toBe(true);
    expect(copy.groups).toEqual([
      {
        key: "g_1",
        name: "Manticore",
        kind: "team",
        size: 6,
        tag: "MAN",
        marker: "🟢",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ]);
  });
});

describe("effectiveChannelLeadMinutes", () => {
  it("prefers the event's own value, including 0", () => {
    expect(effectiveChannelLeadMinutes({ channelLeadMinutes: 45 }, 15)).toBe(
      45,
    );
    expect(effectiveChannelLeadMinutes({ channelLeadMinutes: 0 }, 15)).toBe(0);
  });
  it("falls back to the global value for null and missing", () => {
    expect(effectiveChannelLeadMinutes({ channelLeadMinutes: null }, 15)).toBe(
      15,
    );
    expect(effectiveChannelLeadMinutes({}, 15)).toBe(15);
  });
});

describe("resolveGroupCountLimits", () => {
  it("clamps to 1 <= default <= max <= hard max", () => {
    expect(resolveGroupCountLimits(2, 15)).toEqual({
      defaultCount: 2,
      maxCount: 15,
    });
    expect(resolveGroupCountLimits(50, 10)).toEqual({
      defaultCount: 10,
      maxCount: 10,
    });
    expect(resolveGroupCountLimits(0, 999)).toEqual({
      defaultCount: 1,
      maxCount: GROUP_COUNT_HARD_MAX,
    });
    expect(resolveGroupCountLimits(NaN, NaN)).toEqual({
      defaultCount: 2,
      maxCount: 15,
    });
  });
});

describe("the Captains lobby switch (#1251)", () => {
  const setup = (i: GroupSetupInput, maxCount = 15) => {
    const result = validateGroupSetup(i, { maxCount });
    if (!result.ok) throw new Error(`unexpected errors: ${result.errors}`);
    return result.setup;
  };

  it("adds one hidden leads group after the typed rows, with every field explicit, while leaders are on", () => {
    const groups = setup(
      input({ captainsEnabled: true, captainsLobby: true }),
    ).groups;
    expect(groups.map((g) => [g.name, g.kind])).toEqual([
      ["Group 1", "team"],
      ["Group 2", "team"],
      ["Leader lobby", "leads"],
    ]);
    expect(groups[2]).toEqual({
      key: expect.stringMatching(/^g_[0-9a-f]{8}$/),
      name: "Leader lobby",
      kind: "leads",
      size: null,
      tag: "",
      marker: "",
      channelId: null,
      captainId: null,
      memberIds: [],
    });
  });

  it("is named after the leader label", () => {
    const groups = setup(
      input({
        captainsEnabled: true,
        captainsLobby: true,
        leaderLabel: "Squad Lead",
      }),
    ).groups;
    expect(groups[2].name).toBe("Squad Lead lobby");
  });

  it("is ignored while leaders are off, like leader customisation", () => {
    for (const captainsEnabled of [false, undefined]) {
      const groups = setup(
        input({ captainsEnabled, captainsLobby: true }),
      ).groups;
      expect(groups.map((g) => g.kind)).toEqual(["team", "team"]);
    }
  });

  it("is off unless asked for", () => {
    const groups = setup(input({ captainsEnabled: true })).groups;
    expect(groups.map((g) => g.kind)).toEqual(["team", "team"]);
  });

  it("never makes a second leads group: a leads row among the rows is the lobby already", () => {
    const groups = setup(
      input({
        captainsEnabled: true,
        captainsLobby: true,
        rows: [row(1), row(2, { name: "Command", kind: "leads" })],
      }),
    ).groups;
    expect(groups.map((g) => [g.name, g.kind])).toEqual([
      ["Group 1", "team"],
      ["Command", "leads"],
    ]);
  });

  it("is not a group to run an event with: it does not satisfy 'add at least one group'", () => {
    const errors = errorsOf(
      input({ captainsEnabled: true, captainsLobby: true, rows: [] }),
    );
    expect(errors).toEqual([
      "Add at least one group, or switch groups off. Give each group a name.",
    ]);
  });

  it("counts toward the group limit and says so", () => {
    const errors = errorsOf(
      input({ captainsEnabled: true, captainsLobby: true }),
      2,
    );
    expect(errors).toEqual([
      "An event can have at most 2 groups (events.groups.max_count); this has 3, counting the captains lobby.",
    ]);
    expect(() =>
      setup(input({ captainsEnabled: true, captainsLobby: true }), 3),
    ).not.toThrow();
  });

  it("takes a name no typed group has", () => {
    const groups = setup(
      input({
        captainsEnabled: true,
        captainsLobby: true,
        rows: [row(1, { name: "leader LOBBY" }), row(2)],
      }),
    ).groups;
    expect(groups[2].name).toBe("Leader lobby 2");
  });

  it("is read from the form, and a preset's leads row stays a row", () => {
    expect(
      parseGroupForm({ groups_captains: "1", groups_captains_lobby: "1" })
        .captainsLobby,
    ).toBe(true);
    expect(parseGroupForm({ groups_captains: "1" }).captainsLobby).toBe(false);
    const result = validateGroupSetup(
      input({ presetId: "custom", rows: [row(1), row(2, { kind: "leads" })] }),
      { maxCount: 15 },
    );
    expect(result.ok && result.setup.groups.map((g) => g.kind)).toEqual([
      "team",
      "leads",
    ]);
  });
});

describe("captainsLobbyName and hasCaptainsLobby", () => {
  it("truncates a long label so the whole name fits, and numbers past a clash", () => {
    const name = captainsLobbyName("L".repeat(60), []);
    expect(name.length).toBeLessThanOrEqual(GROUP_NAME_MAX);
    expect(name.endsWith(" lobby")).toBe(true);
    const next = captainsLobbyName("L".repeat(60), [name]);
    expect(next).not.toBe(name);
    expect(next.length).toBeLessThanOrEqual(GROUP_NAME_MAX);
    expect(next.endsWith(" lobby 2")).toBe(true);
  });

  it("falls back to the default label", () => {
    expect(captainsLobbyName("  ", [])).toBe("Leader lobby");
  });

  it("reads the presence of a leads group", () => {
    expect(hasCaptainsLobby(undefined)).toBe(false);
    expect(hasCaptainsLobby([{ kind: "team" }, { kind: "open" }])).toBe(false);
    expect(hasCaptainsLobby([{ kind: "team" }, { kind: "leads" }])).toBe(true);
  });
});

describe("the series group setup (#1266)", () => {
  const liveRow = {
    groupsEnabled: true,
    groupsLocked: true,
    presetId: "builtin:eve",
    groupLabel: "Squad",
    leaderLabel: "Captain",
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    tagsEnabled: true,
    tagsSuffix: true,
    groups: [
      {
        key: "g_a",
        // A leader renamed and retagged it; the host's values are the originals.
        name: "Quizzzzbois",
        tag: "QZ",
        originalName: "Caldari",
        originalTag: "CAL",
        kind: "team" as const,
        size: 6,
        marker: "x",
        channelId: "c-a",
        captainId: "u-leader",
        memberIds: ["u1", "u2"],
      },
      {
        key: "g_b",
        name: "Gallente",
        tag: "GAL",
        kind: "open" as const,
        size: null,
        marker: "",
        channelId: "c-b",
        captainId: null,
        memberIds: [],
      },
    ],
  };

  it("takes the host's names and tags and the switches, never the lock, and no person or channel", () => {
    expect(seriesGroupSetupOf(liveRow)).toEqual({
      groupsEnabled: true,
      presetId: "builtin:eve",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      tagsEnabled: true,
      tagsSuffix: true,
      groups: [
        {
          key: "g_a",
          name: "Caldari",
          kind: "team",
          size: 6,
          tag: "CAL",
          marker: "x",
        },
        {
          key: "g_b",
          name: "Gallente",
          kind: "open",
          size: null,
          tag: "GAL",
          marker: "",
        },
      ],
    });
  });

  it("keeps no groups for a series with groups off", () => {
    expect(seriesGroupSetupOf({ ...liveRow, groupsEnabled: false })).toEqual(
      expect.objectContaining({
        groupsEnabled: false,
        groups: [],
      }),
    );
    expect(seriesGroupSetupOf({})).toEqual({
      groupsEnabled: false,
      presetId: null,
      groupLabel: "Team",
      leaderLabel: "Leader",
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      tagsEnabled: false,
      tagsSuffix: false,
      groups: [],
    });
  });

  it("reads a stored setup back with defaults for what a lean row lacks, and null for no setup", () => {
    expect(readSeriesGroupSetup(null)).toBeNull();
    expect(readSeriesGroupSetup(undefined)).toBeNull();
    expect(readSeriesGroupSetup({})).toBeNull();
    expect(readSeriesGroupSetup({ groupsEnabled: true })).toEqual({
      groupsEnabled: true,
      presetId: null,
      groupLabel: "Team",
      leaderLabel: "Leader",
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      tagsEnabled: false,
      tagsSuffix: false,
      groups: [],
    });
    const stored = seriesGroupSetupOf(liveRow);
    expect(readSeriesGroupSetup(stored)).toEqual(stored);
    // A lock stored by an earlier build is ignored, never read back.
    expect(
      readSeriesGroupSetup({ ...stored, groupsLocked: true } as never),
    ).toEqual(stored);
  });

  it("keeps the captains lobby as a structural group, without its channel or anybody in it", () => {
    const lobby = {
      key: "g_lobby",
      name: "Captain lobby",
      tag: "",
      kind: "leads" as const,
      size: null,
      marker: "",
      channelId: "c-lobby",
      captainId: "u-leader",
      memberIds: ["u9"],
    };
    const row = { ...liveRow, groups: [...liveRow.groups, lobby] };
    const series = seriesGroupSetupOf(row);
    expect(series.groups.map((g) => [g.key, g.kind])).toEqual([
      ["g_a", "team"],
      ["g_b", "open"],
      ["g_lobby", "leads"],
    ]);
    const text = JSON.stringify(series);
    for (const forbidden of ["c-lobby", "u-leader", "u9"]) {
      expect(text).not.toContain(forbidden);
    }
    const next = successorGroupFields(series, null).groups;
    expect(hasCaptainsLobby(next)).toBe(true);
    expect(next[2]).toMatchObject({
      key: "g_lobby",
      channelId: null,
      captainId: null,
      memberIds: [],
    });
  });

  it("builds a successor's fields from it without memberships, leaders or channels", () => {
    // The row was locked (liveRow), and so was a setup an earlier build stored:
    // the successor starts unlocked either way.
    const fields = successorGroupFields(seriesGroupSetupOf(liveRow), 25);
    expect(fields).toMatchObject({
      groupsEnabled: true,
      groupsLocked: false,
      channelLeadMinutes: 25,
      groupLabel: "Squad",
    });
    expect(fields.groups).toEqual([
      {
        key: "g_a",
        name: "Caldari",
        kind: "team",
        size: 6,
        tag: "CAL",
        marker: "x",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
      {
        key: "g_b",
        name: "Gallente",
        kind: "open",
        size: null,
        tag: "GAL",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ]);
  });
});
