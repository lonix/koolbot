import { describe, it, expect } from "@jest/globals";
import {
  BUILTIN_WORDING,
  loadWordingDefaults,
  readWordingChoice,
  wordingChoiceFor,
} from "../../src/services/event-group-wording.js";
import {
  groupErrorFields,
  parseGroupForm,
  validateGroupSetup,
  type GroupSetupInput,
} from "../../src/services/event-groups.js";

const ROWS = [
  { position: 1, name: "Red", kind: "team", size: "", tag: "", marker: "" },
];

/** The labels an accepted form stores, from a parsed body. */
function stored(
  body: Record<string, string>,
  wording?: { group: string; leader: string },
):
  | { group: string; leader: string }
  | { errors: string[]; fields: Record<string, string> } {
  const input = parseGroupForm({ groups_enabled: "1", ...body });
  const result = validateGroupSetup(
    { ...input, rows: ROWS } as GroupSetupInput,
    { maxCount: 15, ...(wording ? { wording } : {}) },
  );
  return result.ok
    ? { group: result.setup.groupLabel, leader: result.setup.leaderLabel }
    : {
        errors: result.errors,
        fields: groupErrorFields(result.errors).fields,
      };
}

describe("wording choices (#1471)", () => {
  it.each([
    ["group", "", ""],
    ["group", "Squad", "Squad"],
    ["group", "squad", "custom"],
    ["group", "Raiders", "custom"],
    ["leader", "Captain", "Captain"],
    ["leader", "Squad", "custom"],
  ] as const)("a stored %s wording %j shows as %j", (kind, value, shown) => {
    expect(wordingChoiceFor(kind, value)).toBe(shown);
  });

  it.each([
    [undefined, "text"],
    ["custom", "text"],
    ["", "default"],
    ["Room", "word"],
    ["Captain", "unknown"],
    ["Bogus", "unknown"],
  ] as const)("a posted group choice %j is read as %s", (posted, kind) => {
    expect(readWordingChoice("group", posted).kind).toBe(kind);
  });

  it("falls back to the built-in words for a missing or unlisted configured value", async () => {
    const config = (g: string, l: string) => ({
      getString: async (key: string) => (key.endsWith("group_label") ? g : l),
    });
    expect(await loadWordingDefaults(config("Squad", "Captain"))).toEqual({
      group: "Squad",
      leader: "Captain",
    });
    expect(await loadWordingDefaults(config("", "Chief"))).toEqual(
      BUILTIN_WORDING,
    );
    expect(
      await loadWordingDefaults({
        getString: async () => {
          throw new Error("db down");
        },
      }),
    ).toEqual(BUILTIN_WORDING);
  });
});

describe("a posted wording dropdown (#1471)", () => {
  const squad = { group: "Squad", leader: "Captain" };

  it.each([
    // [what is posted, the server default, what is stored]
    [
      "no dropdown, text only (legacy path)",
      { groups_label: "Crew" },
      undefined,
      "Crew",
    ],
    [
      "server default picked, none set",
      { groups_label_choice: "" },
      undefined,
      "Team",
    ],
    [
      "server default picked, default is Squad",
      { groups_label_choice: "" },
      squad,
      "Squad",
    ],
    [
      "a listed word wins over stale text",
      { groups_label_choice: "Party", groups_label: "Crew" },
      squad,
      "Party",
    ],
    [
      "Custom uses the text",
      { groups_label_choice: "custom", groups_label: "Crew" },
      squad,
      "Crew",
    ],
    [
      "Custom may be a listed word typed out",
      { groups_label_choice: "custom", groups_label: "Team" },
      squad,
      "Team",
    ],
  ] as const)("%s", (_name, body, wording, expected) => {
    expect(stored({ ...body }, wording)).toEqual(
      expect.objectContaining({ group: expected }),
    );
  });

  it("applies the server default to the leader wording too", () => {
    expect(stored({ groups_leader_label_choice: "" }, squad)).toEqual({
      group: "Squad",
      leader: "Captain",
    });
    expect(stored({ groups_leader_label_choice: "Leader" }, squad)).toEqual({
      group: "Squad",
      leader: "Leader",
    });
  });

  it("lets a group preset's own word come before the server default", () => {
    const input = parseGroupForm({
      groups_enabled: "1",
      groups_preset: "squads",
      groups_label_choice: "",
    });
    const result = validateGroupSetup(input, {
      maxCount: 15,
      wording: { group: "Party", leader: "Captain" },
      resolvePreset: () => ({
        preset: {
          id: "squads",
          label: "Squads",
          description: "",
          groupLabel: "Squad",
          groups: [
            { name: "Alpha", kind: "team", size: null, tag: "", marker: "" },
          ],
        },
      }),
    });
    expect(result.ok && result.setup.groupLabel).toBe("Squad");
  });

  it.each([
    [
      "an unlisted group word",
      { groups_label_choice: "Bogus" },
      "groups_label",
      "Choose one of the listed words, or Custom.",
    ],
    [
      "a leader word in the group dropdown",
      { groups_label_choice: "Captain" },
      "groups_label",
      "Choose one of the listed words, or Custom.",
    ],
    [
      "Custom with nothing typed",
      { groups_label_choice: "custom", groups_label: "  " },
      "groups_label",
      "Type the wording, or choose another.",
    ],
    [
      "an unlisted leader word",
      { groups_leader_label_choice: "Chief" },
      "groups_leader_label",
      "Choose one of the listed words, or Custom.",
    ],
    [
      "Custom leader with nothing typed",
      { groups_leader_label_choice: "custom" },
      "groups_leader_label",
      "Type the wording, or choose another.",
    ],
  ] as const)("refuses %s, on the field", (_name, body, field, message) => {
    const result = stored({ ...body });
    expect(result).toEqual(
      expect.objectContaining({ fields: { [field]: message } }),
    );
  });

  it("keeps the text and the choice as posted for putting a refused form back", () => {
    const input = parseGroupForm({
      groups_label_choice: "custom",
      groups_label: " Team ",
      groups_leader_label_choice: "Captain",
      groups_leader_label: "stale",
    });
    expect(input).toEqual(
      expect.objectContaining({
        groupLabelChoice: "custom",
        groupLabelText: "Team",
        leaderLabelChoice: "Captain",
        leaderLabelText: "stale",
        groupLabel: "Team",
        leaderLabel: "Captain",
      }),
    );
  });
});
