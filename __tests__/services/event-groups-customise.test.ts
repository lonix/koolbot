import { describe, it, expect } from "@jest/globals";
import {
  GROUP_FORM_FIELDS,
  GROUP_NAME_MAX,
  GROUP_TAG_MAX,
  checkGroupName,
  checkGroupTag,
  copyGroupSetup,
  parseGroupForm,
  validateGroupSetup,
  type GroupSetupInput,
} from "../../src/services/event-groups.js";

function input(over: Partial<GroupSetupInput> = {}): GroupSetupInput {
  return {
    enabled: true,
    presetId: "",
    groupLabel: "",
    leaderLabel: "",
    channelLeadMinutes: "",
    rows: [
      {
        position: 1,
        name: "Red",
        kind: "team",
        size: "",
        tag: "RED",
        marker: "",
      },
      {
        position: 2,
        name: "Blue",
        kind: "team",
        size: "",
        tag: "",
        marker: "",
      },
    ],
    ...over,
  };
}

describe("the shared name and tag rules (#1196)", () => {
  it("checkGroupName: collapses whitespace, requires text, caps the length, refuses control characters", () => {
    expect(checkGroupName("  Dark   Red ")).toEqual({
      ok: true,
      value: "Dark Red",
    });
    expect(checkGroupName("   ")).toMatchObject({
      ok: false,
      error: "a name is required.",
    });
    expect(checkGroupName("x".repeat(GROUP_NAME_MAX))).toMatchObject({
      ok: true,
    });
    expect(checkGroupName("x".repeat(GROUP_NAME_MAX + 1))).toMatchObject({
      ok: false,
      error: expect.stringContaining(`at most ${GROUP_NAME_MAX}`),
    });
    expect(checkGroupName("a\u0000b")).toMatchObject({ ok: false });
    expect(checkGroupName("a\u007fb")).toMatchObject({ ok: false });
  });

  it("checkGroupTag: empty is fine, capped, no control characters", () => {
    expect(checkGroupTag("")).toEqual({ ok: true, value: "" });
    expect(checkGroupTag(" R  D ")).toEqual({ ok: true, value: "R D" });
    expect(checkGroupTag("x".repeat(GROUP_TAG_MAX))).toMatchObject({
      ok: true,
    });
    expect(checkGroupTag("x".repeat(GROUP_TAG_MAX + 1))).toMatchObject({
      ok: false,
      error: expect.stringContaining(`at most ${GROUP_TAG_MAX}`),
    });
    expect(checkGroupTag("a\u0001")).toMatchObject({ ok: false });
  });

  it("the event form uses the same rules and keeps its messages", () => {
    const r = validateGroupSetup(
      input({
        rows: [
          {
            position: 1,
            name: " ",
            kind: "team",
            size: "",
            tag: "123456789",
            marker: "",
          },
          {
            position: 2,
            name: "x".repeat(60),
            kind: "team",
            size: "",
            tag: "",
            marker: "",
          },
          {
            position: 3,
            name: "Red",
            kind: "team",
            size: "",
            tag: "",
            marker: "",
          },
          {
            position: 4,
            name: "red",
            kind: "team",
            size: "",
            tag: "",
            marker: "",
          },
        ],
      }),
      { maxCount: 15 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(
        expect.arrayContaining([
          "Group 1 name: a name is required.",
          expect.stringMatching(/^Group 1 tag: at most 8 characters/),
          expect.stringMatching(
            /^Group 2 name: at most 50 characters \(got 60\)\.$/,
          ),
          'Group 4 name: "red" is already used by group 3; names must be unique.',
        ]),
      );
    }
  });
});

describe("the customisation toggle on the event form (#1196)", () => {
  it("is read from its own field", () => {
    const form = parseGroupForm({
      groups_enabled: "1",
      groups_captains: "1",
      [GROUP_FORM_FIELDS.captainCustom]: "1",
    });
    expect(form.captainCustomisationEnabled).toBe(true);
    expect(
      parseGroupForm({ groups_enabled: "1" }).captainCustomisationEnabled,
    ).toBe(false);
  });

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    "leaders=%s customise=%s is stored as %s (only effective with leaders on)",
    (captains, custom, stored) => {
      const r = validateGroupSetup(
        input({
          captainsEnabled: captains,
          captainCustomisationEnabled: custom,
        }),
        { maxCount: 15 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.setup.captainCustomisationEnabled).toBe(stored);
    },
  );

  it("off by default, and a plain event stores nothing", () => {
    const r = validateGroupSetup(input(), { maxCount: 15 });
    expect(r.ok && r.setup.captainCustomisationEnabled).toBe(false);
    const off = validateGroupSetup(
      input({
        enabled: false,
        captainsEnabled: true,
        captainCustomisationEnabled: true,
      }),
      { maxCount: 15 },
    );
    expect(off.ok && off.setup.captainCustomisationEnabled).toBe(false);
  });
});

describe("a recurring series' next occurrence (#1196)", () => {
  it("starts from what the host set, not from a leader's rename, and keeps the toggle", () => {
    const next = copyGroupSetup({
      groupsEnabled: true,
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      groups: [
        {
          key: "g_00000001",
          name: "Crimson",
          tag: "CRM",
          kind: "team",
          originalName: "Red",
          originalTag: "RED",
        },
        { key: "g_00000002", name: "Blue", tag: "BLU", kind: "team" },
      ],
    });
    expect(next.captainCustomisationEnabled).toBe(true);
    expect(next.groups[0]).toMatchObject({
      name: "Red",
      tag: "RED",
      channelId: null,
      captainId: null,
      memberIds: [],
    });
    expect(next.groups[0]).not.toHaveProperty("originalName");
    expect(next.groups[0]).not.toHaveProperty("nameSyncPending");
    expect(next.groups[0]).not.toHaveProperty("controlMessageId");
    expect(next.groups[1]).toMatchObject({ name: "Blue", tag: "BLU" });
  });

  it("restores an original tag that was empty", () => {
    const next = copyGroupSetup({
      groupsEnabled: true,
      groups: [
        {
          key: "g_00000001",
          name: "Crimson",
          tag: "CRM",
          kind: "team",
          originalName: "Red",
          originalTag: "",
        },
      ],
    });
    expect(next.groups[0]).toMatchObject({ name: "Red", tag: "" });
  });
});
