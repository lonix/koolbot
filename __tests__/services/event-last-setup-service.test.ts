/**
 * The remembered group setup (#1406): what is stored after a create, and how a
 * stored row is re-validated before it prefills the next form. The model is
 * stubbed; the validator is the real one.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockFindOne =
  jest.fn<(filter: unknown) => { lean: () => Promise<unknown> }>();
const mockFindOneAndUpdate =
  jest.fn<
    (filter: unknown, update: unknown, opts: unknown) => Promise<unknown>
  >();
jest.unstable_mockModule("../../src/models/event-group-last-setup.js", () => ({
  EventGroupLastSetup: {
    findOne: mockFindOne,
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { prefillFromStored, loadGroupPrefill, rememberLastSetup } =
  await import("../../src/services/event-last-setup-service.js");
const { emptyGroupSetup } = await import("../../src/services/event-groups.js");
type Setup = ReturnType<typeof emptyGroupSetup>;

const preset = {
  id: "lib:clan",
  label: "Clan match",
  description: "",
  groupLabel: "Squad",
  groups: [
    { name: "A", kind: "team" as const, size: 5, tag: "A", marker: "" },
    { name: "B", kind: "team" as const, size: 5, tag: "B", marker: "" },
  ],
};
const ctx = { maxCount: 15, presets: [preset] };

function stored(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guildId: "g1",
    ownerId: "u1",
    presetId: null,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    groups: [
      { name: "Red", kind: "team", size: 5, tag: "RED", marker: "🔴" },
      { name: "Blue", kind: "team", size: null, tag: "", marker: "" },
    ],
    captainsEnabled: true,
    captainCustomisationEnabled: false,
    captainsLobby: true,
    tagsEnabled: true,
    tagsSuffix: false,
    ...extra,
  };
}

describe("prefillFromStored", () => {
  it("turns a valid row into form values", () => {
    const out = prefillFromStored(stored(), ctx);
    expect(out).not.toBeNull();
    expect(out?.presetId).toBe("");
    expect(out?.groupLabel).toBe("");
    expect(out?.leaderLabel).toBe("");
    expect(out?.channelLeadMinutes).toBe("");
    expect(out?.rows).toEqual([
      { name: "Red", kind: "team", size: "5", tag: "RED", marker: "🔴" },
      { name: "Blue", kind: "team", size: "", tag: "", marker: "" },
    ]);
    expect(out).toMatchObject({
      captainsEnabled: true,
      captainsLobby: true,
      tagsEnabled: true,
      tagsSuffix: false,
    });
  });

  it("keeps a preset that is still offered and fits the cap", () => {
    const out = prefillFromStored(
      stored({
        presetId: "lib:clan",
        groupLabel: "Squad",
        channelLeadMinutes: 10,
      }),
      ctx,
    );
    expect(out?.presetId).toBe("lib:clan");
    // Equal to what the preset supplies when the box is empty, so left empty.
    expect(out?.groupLabel).toBe("");
    expect(out?.channelLeadMinutes).toBe("10");
  });

  it("keeps an explicit default wording when the preset's own wording differs", () => {
    const wordy = { ...preset, leaderLabel: "Captain" };
    const out = prefillFromStored(
      stored({
        presetId: "lib:clan",
        groupLabel: "Team",
        leaderLabel: "Leader",
      }),
      { maxCount: 15, presets: [wordy] },
    );
    // An empty box would turn into "Squad" / "Captain" on submit.
    expect(out?.groupLabel).toBe("Team");
    expect(out?.leaderLabel).toBe("Leader");
    // Under Custom (no preset fallback) the default words are still blanked.
    const custom = prefillFromStored(stored(), ctx);
    expect(custom?.groupLabel).toBe("");
    expect(custom?.leaderLabel).toBe("");
  });

  it("blanks a wording only when it equals the server default, and keeps any other (#1471)", () => {
    const wording = { group: "Squad", leader: "Captain" };
    const withServer = { maxCount: 15, presets: [], wording };
    // The server default is shown as the "Server default" choice: stored empty.
    const same = prefillFromStored(
      stored({ groupLabel: "Squad", leaderLabel: "Captain" }),
      withServer,
    );
    expect(same?.groupLabel).toBe("");
    expect(same?.leaderLabel).toBe("");
    // The built-in "Team" is an explicit word now, not the default: it stays.
    const other = prefillFromStored(stored(), withServer);
    expect(other?.groupLabel).toBe("Team");
    expect(other?.leaderLabel).toBe("Leader");
  });

  it("falls back to Custom, keeping the rows, when the preset is gone", () => {
    const out = prefillFromStored(stored({ presetId: "lib:deleted" }), ctx);
    expect(out?.presetId).toBe("");
    expect(out?.rows).toHaveLength(2);
  });

  it("falls back to Custom when the preset no longer fits the cap", () => {
    const out = prefillFromStored(stored({ presetId: "lib:clan" }), {
      maxCount: 1,
      presets: [preset],
    });
    // The two saved rows exceed a cap of one, so nothing is prefilled.
    expect(out).toBeNull();
    const fits = prefillFromStored(
      stored({
        presetId: "lib:clan",
        captainsLobby: false,
        groups: [
          { name: "Red", kind: "team", size: null, tag: "", marker: "" },
        ],
      }),
      { maxCount: 1, presets: [preset] },
    );
    expect(fits?.presetId).toBe("");
  });

  it("is ignored when the rows no longer fit the group cap, lobby included", () => {
    expect(
      prefillFromStored(stored(), { maxCount: 2, presets: [] }),
    ).toBeNull();
    expect(
      prefillFromStored(stored(), { maxCount: 3, presets: [] }),
    ).not.toBeNull();
  });

  it("is ignored for an over-long marker or tag", () => {
    const groups = (g: Record<string, unknown>): unknown[] => [
      { name: "Red", kind: "team", size: null, tag: "", marker: "", ...g },
    ];
    expect(
      prefillFromStored(
        stored({ groups: groups({ marker: "🔴🔵🟢🟡🟠" }) }),
        ctx,
      ),
    ).toBeNull();
    expect(
      prefillFromStored(stored({ groups: groups({ tag: "TOOLONGTAG" }) }), ctx),
    ).toBeNull();
    expect(
      prefillFromStored(stored({ groups: groups({ size: 500 }) }), ctx),
    ).toBeNull();
  });

  it("does not light the lobby without leaders", () => {
    const out = prefillFromStored(
      stored({ captainsEnabled: false, captainsLobby: true }),
      ctx,
    );
    expect(out?.captainsLobby).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["no groups", stored({ groups: [] })],
    ["groups not an array", stored({ groups: "nope" })],
    ["a row that is not an object", stored({ groups: ["x"] })],
    [
      "a nameless row",
      stored({ groups: [{ kind: "team", name: "", size: 1 }] }),
    ],
    ["a lead time out of range", stored({ channelLeadMinutes: 99999 })],
  ])("is ignored for %s", (_n, value) => {
    expect(prefillFromStored(value, ctx)).toBeNull();
  });
});

describe("loadGroupPrefill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads only the signed-in host's row", async () => {
    mockFindOne.mockReturnValue({ lean: async () => stored() });
    const out = await loadGroupPrefill("g1", "u1", ctx);
    expect(mockFindOne).toHaveBeenCalledWith({ guildId: "g1", ownerId: "u1" });
    expect(out?.rows).toHaveLength(2);
  });

  it("does not read without a host", async () => {
    expect(await loadGroupPrefill("g1", undefined, ctx)).toBeNull();
    expect(await loadGroupPrefill("", "u1", ctx)).toBeNull();
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("returns null for a missing row", async () => {
    mockFindOne.mockReturnValue({ lean: async () => null });
    expect(await loadGroupPrefill("g1", "u1", ctx)).toBeNull();
  });

  it("returns null, never throws, when the read fails", async () => {
    mockFindOne.mockReturnValue({
      lean: async () => {
        throw new Error("mongo down");
      },
    });
    expect(await loadGroupPrefill("g1", "u1", ctx)).toBeNull();
  });
});

describe("rememberLastSetup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({});
  });

  function setup(extra: Partial<Setup> = {}): Setup {
    return {
      ...emptyGroupSetup(),
      groupsEnabled: true,
      presetId: "lib:clan",
      groupLabel: "Squad",
      captainsEnabled: true,
      groups: [
        {
          key: "g_aaaaaaaa",
          name: "Red",
          kind: "team",
          size: 5,
          tag: "RED",
          marker: "🔴",
          channelId: "chan",
          captainId: "cap",
          memberIds: ["m1"],
        },
        {
          key: "g_bbbbbbbb",
          name: "Leaders",
          kind: "leads",
          size: null,
          tag: "",
          marker: "",
          channelId: null,
          captainId: null,
          memberIds: [],
        },
      ],
      ...extra,
    };
  }

  it("replaces the host's row with the setup only, lobby as a switch", async () => {
    await rememberLastSetup("g1", "u1", setup());
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = mockFindOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
      unknown,
    ];
    expect(filter).toEqual({ guildId: "g1", ownerId: "u1" });
    expect(opts).toMatchObject({ upsert: true, runValidators: true });
    expect(update.$set).toMatchObject({
      presetId: "lib:clan",
      groupLabel: "Squad",
      captainsEnabled: true,
      captainsLobby: true,
      groups: [
        { name: "Red", kind: "team", size: 5, tag: "RED", marker: "🔴" },
      ],
    });
    // No channel, leader, member or key ever reaches the store.
    expect(JSON.stringify(update)).not.toMatch(
      /channelId|captainId|memberIds|"key"|"m1"|"chan"|g_aaaaaaaa/,
    );
  });

  it("leaves the stored setup alone for a plain event", async () => {
    await rememberLastSetup("g1", "u1", emptyGroupSetup());
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("swallows a failed write", async () => {
    mockFindOneAndUpdate.mockRejectedValue(new Error("mongo down"));
    await expect(
      rememberLastSetup("g1", "u1", setup()),
    ).resolves.toBeUndefined();
  });
});
