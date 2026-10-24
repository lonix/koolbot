import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The group editor of the Live settings section (#1241): the controls, what a
 * posted form turns into, and that the content of a preset always comes from
 * the server's own catalog.
 */

type Catalog =
  import("../../src/services/event-group-preset-service.js").PresetCatalog;

let catalog: Catalog = { entries: [], state: "ok" };
const actual = await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({
    ...actual,
    loadPresetCatalog: async () => catalog,
  }),
);

const {
  renderGroupEditor,
  renderPresetForm,
  renderGroupSetForms,
  buildGroupEditView,
  prepareGroupEditBody,
  PRESET_PICK_FIELD,
} = await import("../../src/web/host-settings-groups.js");
const { renderGroupChanges, renderEventSettings } =
  await import("../../src/web/host-settings-view.js");
type GroupEditViewData =
  import("../../src/web/host-settings-groups.js").GroupEditViewData;

const entryOf = (
  id: string,
  groups: Array<{ name: string; kind: "team" | "open" | "leads" }>,
  enabled = true,
) => ({
  id,
  source: "builtin" as const,
  label: `Label ${id}`,
  description: "",
  groupLabel: "Team",
  enabled,
  groups: groups.map((g) => ({ ...g, size: 5, tag: "T", marker: "" })),
});

beforeEach(() => {
  catalog = { entries: [], state: "ok" };
});

const view = (over: Partial<GroupEditViewData> = {}): GroupEditViewData => ({
  groupLabel: "Squad",
  groups: [
    {
      key: "g_00000001",
      kind: "team",
      hasChannel: true,
      name: 'Heli <b>"x"</b>',
      marker: "<i>",
      tag: "HE<L>",
      size: 2,
      memberCount: 3,
      overSize: true,
      namePending: false,
      sizePending: false,
    },
    {
      key: "g_00000002",
      kind: "open",
      hasChannel: false,
      name: "Logi",
      marker: "",
      tag: "",
      size: null,
      memberCount: 0,
      overSize: false,
      namePending: true,
      sizePending: true,
    },
  ],
  presets: [{ id: "builtin:a", label: "A <script>" }],
  presetNotice: null,
  presetBase: '{"id":"","groups":[{"name":"<x>"}]}',
  addKey: "g_0000abcd",
  ...over,
});

describe("renderGroupEditor", () => {
  it("renders nothing for an event whose only group is the hidden lobby (#1251)", () => {
    const only = view().groups[0];
    expect(
      renderGroupEditor(view({ groups: [{ ...only, kind: "leads" }] })),
    ).toBe("");
  });

  /** The attributes of the one input of the page with this name. */
  const inputOf = (html: string, name: string): string => {
    const m = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html);
    if (!m) throw new Error(`no input named ${name}`);
    return m[0];
  };

  it("renders one name and one size field per group with the value it shows as the base", () => {
    const html = renderGroupEditor(view());
    expect(inputOf(html, "s_groupNameA")).toContain('maxlength="50"');
    expect(inputOf(html, "b_groupNameA")).toContain('value="Heli');
    expect(inputOf(html, "s_groupSizeA")).toContain('value="2"');
    expect(inputOf(html, "s_groupSizeA")).toContain('min="1" max="99"');
    expect(inputOf(html, "b_groupSizeA")).toContain('value="2"');
    expect(html).toContain('name="s_groupNameB"');
    // No size is shown as empty, and as an empty base.
    expect(inputOf(html, "s_groupSizeB")).toContain('value=""');
    expect(inputOf(html, "b_groupSizeB")).toContain('value=""');
    // Each position posts the key of the group it showed (the stale guard).
    expect(inputOf(html, "k_groupNameA")).toContain('value="g_00000001"');
    expect(inputOf(html, "k_groupSizeA")).toContain('value="g_00000001"');
    expect(inputOf(html, "k_groupNameB")).toContain('value="g_00000002"');
    expect(inputOf(html, "k_groupSizeB")).toContain('value="g_00000002"');
  });

  it("renders the event form's group rows: a marker and a tag per group, with their shown values, by group key", () => {
    const html = renderGroupEditor(view());
    expect(html).toContain("data-group-row");
    expect(html).toContain("kb-grouprows__head");
    expect(html).toContain("data-marker-input");
    expect(inputOf(html, "s_groupMarkers_g_00000001")).toContain(
      'value="&lt;i&gt;"',
    );
    expect(inputOf(html, "b_groupMarkers_g_00000001")).toContain(
      'value="&lt;i&gt;"',
    );
    expect(inputOf(html, "s_groupMarkers_g_00000002")).toContain('value=""');
    expect(inputOf(html, "b_groupMarkers_g_00000002")).toContain('value=""');
    expect(inputOf(html, "s_groupTags_g_00000001")).toContain(
      'value="HE&lt;L&gt;"',
    );
    expect(inputOf(html, "b_groupTags_g_00000001")).toContain(
      'value="HE&lt;L&gt;"',
    );
  });

  it("an open group has a marker but no tag field (only a team carries a tag), and no group has a kind select (a kind cannot change here)", () => {
    const html = renderGroupEditor(view());
    expect(html).not.toContain("s_groupTags_g_00000002");
    expect(html).not.toContain("b_groupTags_g_00000002");
    expect(html).toContain("only a team carries a tag");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("data-kind-toggle");
    expect(html).not.toContain("data-kind-panel");
    expect(html).not.toContain("group_0_kind");
  });

  it("posts no field of the event form's own names (group_<n>_*)", () => {
    expect(renderGroupEditor(view())).not.toMatch(/name="group_\d+_/);
  });

  it("escapes every dynamic value", () => {
    const html = renderGroupEditor(view());
    expect(html).toContain('value="Heli &lt;b&gt;&quot;x&quot;&lt;/b&gt;"');
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;i&gt;");
  });

  it("marks a group over size and shows pending channel work", () => {
    const html = renderGroupEditor(view());
    expect(html).toContain("over size");
    expect(html).toContain("channel rename pending");
    expect(html).toContain("channel limit pending");
    expect(renderGroupEditor(view({ groups: [] }))).toBe("");
  });

  it("says what lowering a size does", () => {
    expect(renderGroupEditor(view())).toContain(
      "moves nobody, the group is marked over size",
    );
  });
});

describe("renderPresetForm", () => {
  it("is its own form with the csrf token, the base and only the offered presets", () => {
    const html = renderPresetForm(view(), "/me/events/e/host/settings", "tok");
    expect(html).toContain(
      '<form method="POST" action="/me/events/e/host/settings">',
    );
    expect(html).toContain('name="_csrf" value="tok"');
    expect(html).toContain(`name="${PRESET_PICK_FIELD}"`);
    expect(html).toContain('<option value="">Keep the current groups</option>');
    expect(html).toContain(
      '<option value="builtin:a">A &lt;script&gt;</option>',
    );
    expect(html).toContain(
      'name="b_groupPreset" value="{&quot;id&quot;:&quot;&quot;,&quot;groups&quot;:[{&quot;name&quot;:&quot;&lt;x&gt;&quot;}]}"',
    );
    // The content of a preset is never a field of the page.
    expect(html).not.toContain('name="s_groupPreset"');
    expect(html).not.toContain("<script>");
  });

  it("explains when no preset fits and shows the catalog notice", () => {
    const html = renderPresetForm(
      view({ presets: [], presetNotice: "The library could not be read." }),
      "/x",
      "t",
    );
    expect(html).toContain(
      "No preset on this server fits this event's 2 groups.",
    );
    expect(html).toContain("The library could not be read.");
    expect(html).not.toContain("<form");
  });
});

describe("Change the groups puts the editor in a form of its own, apart from Event settings", () => {
  it("renders both, and falls back to the read-only table without a group editor", () => {
    const base = {
      csrfToken: "tok",
      actionPath: (a: string) => `/p/${a}`,
      blocker: null,
      leadMinutes: null,
      leadReadOnly: null,
      groupLabel: "Squad",
      groups: [
        { name: "G", marker: "", size: 1, memberCount: 0, overSize: false },
      ],
    };
    const withEditor = renderGroupChanges({ ...base, groupEdit: view() });
    // The names form, the preset form, and the remove and add forms (#1242).
    expect(withEditor.split("<form ").length - 1).toBe(4);
    const first = withEditor.slice(0, withEditor.indexOf("</form>"));
    expect(first).toContain('name="s_groupNameA"');
    expect(first).toContain('name="s_groupMarkers_g_00000001"');
    expect(first).toContain('name="s_groupTags_g_00000001"');
    expect(first).not.toContain("preset_pick");
    expect(withEditor.slice(withEditor.indexOf("</form>"))).toContain(
      "preset_pick",
    );
    // Event settings never carries the group rows, so a save there leaves them alone.
    expect(renderEventSettings({ ...base, groupEdit: view() })).not.toContain(
      "s_groupNameA",
    );
    // The group rows script is on the page with the rows, and only then.
    expect(withEditor).toContain("koolGroupRows");
    expect(renderGroupChanges(base)).not.toContain("koolGroupRows");
    const plain = renderGroupChanges(base);
    expect(plain).not.toContain("s_groupNameA");
    expect(plain).toContain("prefs-table");
  });

  it("shows no editor while the section is blocked", () => {
    const html = renderGroupChanges({
      csrfToken: "t",
      actionPath: (a) => a,
      blocker: "Events are turned off",
      leadMinutes: null,
      leadReadOnly: null,
      groupLabel: "Squad",
      groups: [],
      groupEdit: view(),
    });
    expect(html).not.toContain("s_groupNameA");
  });
});

describe("buildGroupEditView", () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({
      guildId: "g",
      groupLabel: "Squad",
      presetId: null,
      groups: [
        {
          key: "g_00000001",
          name: "A",
          kind: "team",
          size: 1,
          tag: "",
          channelId: "c",
          nameSyncPending: true,
          sizeSyncPending: false,
          memberIds: ["u1", "u2"],
        },
        {
          key: "g_00000002",
          name: "B",
          kind: "open",
          size: null,
          memberIds: [],
        },
      ],
      ...over,
    }) as never;

  it("derives over size from members and size and reports pending channel work", async () => {
    const data = await buildGroupEditView(event());
    expect(data.groups).toMatchObject([
      {
        name: "A",
        size: 1,
        memberCount: 2,
        overSize: true,
        namePending: true,
        sizePending: false,
      },
      {
        name: "B",
        size: null,
        memberCount: 0,
        overSize: false,
        namePending: false,
      },
    ]);
    expect(JSON.parse(data.presetBase)).toEqual({
      id: "",
      groups: [
        { name: "A", kind: "team", size: 1, tag: "" },
        { name: "B", kind: "open", size: null, tag: "" },
      ],
    });
  });

  it("offers only enabled presets with the same number of groups and the same kinds", async () => {
    catalog = {
      state: "ok",
      entries: [
        entryOf("fits", [
          { name: "X", kind: "team" },
          { name: "Y", kind: "open" },
        ]),
        entryOf("wrong-kind", [
          { name: "X", kind: "team" },
          { name: "Y", kind: "team" },
        ]),
        entryOf("wrong-count", [{ name: "X", kind: "team" }]),
        entryOf(
          "off",
          [
            { name: "X", kind: "team" },
            { name: "Y", kind: "open" },
          ],
          false,
        ),
      ],
    };
    const data = await buildGroupEditView(event());
    expect(data.presets.map((p) => p.id)).toEqual(["fits"]);
  });

  it("passes on the catalog notice when the library could not be read", async () => {
    catalog = { entries: [], state: "all-unreadable" };
    const data = await buildGroupEditView(event());
    expect(data.presets).toEqual([]);
    expect(data.presetNotice).toContain("could not be read");
  });
});

describe("prepareGroupEditBody: a preset's content comes from the server's catalog", () => {
  const known = entryOf("builtin:known", [
    { name: "One", kind: "team" },
    { name: "Two", kind: "team" },
  ]);

  it("resolves a chosen id to the preset's content, by position", async () => {
    catalog = { entries: [known], state: "ok" };
    const out = await prepareGroupEditBody(
      { [PRESET_PICK_FIELD]: "builtin:known", b_groupPreset: "{}", _csrf: "t" },
      "g",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(JSON.parse(out.body.s_groupPreset as string)).toEqual({
      id: "builtin:known",
      groups: [
        { name: "One", kind: "team", size: 5, tag: "T" },
        { name: "Two", kind: "team", size: 5, tag: "T" },
      ],
    });
    expect(out.body.b_groupPreset).toBe("{}");
    expect(PRESET_PICK_FIELD in out.body).toBe(false);
  });

  it("DROPS content posted by the client: s_groupPreset is never read", async () => {
    catalog = { entries: [known], state: "ok" };
    const forged = JSON.stringify({
      id: "builtin:known",
      groups: [{ name: "Evil", kind: "team", size: 99, tag: "" }],
    });
    const without = await prepareGroupEditBody(
      { s_groupPreset: forged, b_groupPreset: "{}" },
      "g",
    );
    expect(without.ok && "s_groupPreset" in without.body).toBe(false);
    const withPick = await prepareGroupEditBody(
      { s_groupPreset: forged, [PRESET_PICK_FIELD]: "builtin:known" },
      "g",
    );
    expect(withPick.ok && withPick.body.s_groupPreset).not.toContain("Evil");
  });

  it("no pick leaves the other fields alone", async () => {
    const out = await prepareGroupEditBody(
      {
        s_channelLeadMinutes: "5",
        b_channelLeadMinutes: "",
        [PRESET_PICK_FIELD]: "",
      },
      "g",
    );
    expect(out).toEqual({
      ok: true,
      body: { s_channelLeadMinutes: "5", b_channelLeadMinutes: "" },
    });
    expect(await prepareGroupEditBody(undefined, "g")).toEqual({
      ok: true,
      body: {},
    });
  });

  it("fails closed for a preset that is unknown, switched off, or cannot be checked", async () => {
    catalog = {
      entries: [entryOf("builtin:off", [{ name: "A", kind: "team" }], false)],
      state: "ok",
    };
    const pick = (id: string) =>
      prepareGroupEditBody({ [PRESET_PICK_FIELD]: id }, "g");
    expect(await pick("builtin:nope")).toEqual({
      ok: false,
      error: "That preset does not exist (any more). Reload the page.",
    });
    expect(await pick("builtin:off")).toEqual({
      ok: false,
      error: "That preset is switched off on this server.",
    });
    catalog = { entries: [], state: "all-unreadable" };
    expect(await pick("builtin:known")).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read"),
    });
  });
});

describe("renderGroupSetForms (#1242)", () => {
  const html = (over: Partial<GroupEditViewData> = {}): string =>
    renderGroupSetForms(view(over), "/p/settings", "tok");

  it("is two forms of their own, each with the csrf token", () => {
    const out = html();
    expect(out.split("<form ").length - 1).toBe(2);
    expect(out.split('name="_csrf" value="tok"').length - 1).toBe(2);
    expect(out.split('action="/p/settings"').length - 1).toBe(2);
  });

  it("lists a checkbox per group named by its KEY, with what removal does, escaped", () => {
    const out = html();
    expect(out).toContain('name="s_groupRemove_g_00000001" value="1"');
    expect(out).toContain('name="s_groupRemove_g_00000002" value="1"');
    expect(out).toContain("3 people assigned, has a voice channel");
    expect(out).toContain("nobody assigned, no channel yet");
    expect(out).toContain('name="b_groupRemove" value="[]"');
    expect(out).toContain("Heli &lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(out).not.toContain("<b>");
    expect(out).toContain("you included");
  });

  it("the add form carries the minted key and the empty base, and the two kinds (leads is the Captains lobby switch)", () => {
    const out = html();
    expect(out).toContain('name="s_groupAdd_key" value="g_0000abcd"');
    expect(out).toContain('name="b_groupAdd" value="[]"');
    expect(out).toContain('name="s_groupAdd_name"');
    expect(out).toContain('maxlength="50"');
    expect(out).toContain('name="s_groupAdd_tag"');
    expect(out).toContain('maxlength="8"');
    for (const kind of ["team", "open"]) {
      expect(out).toContain(`<option value="${kind}">`);
    }
    expect(out).not.toContain('<option value="leads"');
    expect(out).toContain("Add a squad");
  });

  it("escapes a hostile key and label", () => {
    const out = html({ addKey: '"><script>x</script>', groupLabel: "<i>Crew" });
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<i>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("offers no removal for the last group, but still the add form", () => {
    const one = html({ groups: view().groups.slice(0, 1) });
    expect(one).not.toContain("s_groupRemove_");
    expect(one).toContain("An event keeps at least one");
    expect(one.split("<form ").length - 1).toBe(1);
    expect(one).toContain("s_groupAdd_name");
  });

  it("is nothing without groups", () => {
    expect(html({ groups: [] })).toBe("");
  });
});

describe("the size fields carry the key of the group they show (#1242)", () => {
  it("one hidden key per size field", () => {
    const out = renderGroupEditor(view());
    expect(out).toContain('name="k_groupSizeA" value="g_00000001"');
    expect(out).toContain('name="k_groupSizeB" value="g_00000002"');
    expect(out).toContain('name="k_groupNameA" value="g_00000001"');
    expect(out).toContain('name="k_groupNameB" value="g_00000002"');
  });
});

describe("buildGroupEditView gives the group set forms their data (#1242)", () => {
  it("keys, channels and a minted key that no group has", async () => {
    const data = await buildGroupEditView({
      guildId: "g",
      groupLabel: "Squad",
      presetId: null,
      groups: [
        {
          key: "g_00000001",
          name: "A",
          kind: "team",
          channelId: "c",
          memberIds: [],
        },
        { key: "g_00000002", name: "B", kind: "open", memberIds: [] },
      ],
    } as never);
    expect(data.groups.map((g) => [g.key, g.hasChannel])).toEqual([
      ["g_00000001", true],
      ["g_00000002", false],
    ]);
    expect(data.addKey).toMatch(/^g_[0-9a-f]{8}$/);
    expect(["g_00000001", "g_00000002"]).not.toContain(data.addKey);
  });
});

describe("the preset switch and the Captains lobby (#1263)", () => {
  const lobbyEvent = (lobby: boolean) =>
    ({
      guildId: "g",
      groupLabel: "Squad",
      presetId: null,
      groups: [
        { key: "g_00000001", name: "A", kind: "team", size: 1, memberIds: [] },
        ...(lobby
          ? [
              {
                key: "g_00000009",
                name: "Leader lobby",
                kind: "leads",
                size: null,
                memberIds: [],
              },
            ]
          : []),
        {
          key: "g_00000002",
          name: "B",
          kind: "open",
          size: null,
          memberIds: [],
        },
      ],
    }) as never;
  const presetSet = (): void => {
    catalog = {
      state: "ok",
      entries: [
        entryOf("plain", [
          { name: "X", kind: "team" },
          { name: "Y", kind: "open" },
        ]),
        entryOf("with-lobby", [
          { name: "X", kind: "team" },
          { name: "Lobby", kind: "leads" },
          { name: "Y", kind: "open" },
        ]),
        entryOf("lobby-only", [{ name: "Lobby", kind: "leads" }]),
        entryOf("wrong-kind", [
          { name: "X", kind: "team" },
          { name: "Lobby", kind: "leads" },
          { name: "Y", kind: "team" },
        ]),
      ],
    };
  };

  it("an event with a lobby is offered presets with and without one, judged on the visible groups", async () => {
    presetSet();
    const data = await buildGroupEditView(lobbyEvent(true));
    expect(data.presets.map((p) => p.id)).toEqual(["plain", "with-lobby"]);
  });

  it("an event without a lobby is offered a preset that has one", async () => {
    presetSet();
    const data = await buildGroupEditView(lobbyEvent(false));
    expect(data.presets.map((p) => p.id)).toEqual(["plain", "with-lobby"]);
  });

  it("the form's base value leaves the lobby out", async () => {
    presetSet();
    const data = await buildGroupEditView(lobbyEvent(true));
    expect(
      JSON.parse(data.presetBase).groups.map((g: { name: string }) => g.name),
    ).toEqual(["A", "B"]);
  });

  it("the form says the lobby is not counted and a preset never changes it", () => {
    const html = renderPresetForm(view(), "/x", "tok");
    expect(html).toContain("The captains lobby is not counted");
    expect(html).toContain("never changed by a preset");
  });
});
