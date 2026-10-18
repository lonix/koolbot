import { describe, it, expect } from "@jest/globals";
import {
  CHANNEL_LEAD_MAX,
  GROUP_COUNT_HARD_MAX,
  GROUP_NAME_MAX,
  GROUP_TAG_MAX,
  MIN_NICKNAME_ROOM,
  NICKNAME_MAX,
  TAG_DECORATION_LENGTH,
  copyGroupSetup,
  effectiveChannelLeadMinutes,
  emptyGroupSetup,
  parseGroupForm,
  resolveGroupCountLimits,
  validateGroupSetup,
  type GroupSetupInput,
  type RawGroupRow,
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
