import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The group editor of the Live settings section (#1241): the controls, what a
 * posted form turns into, and that the content of a preset always comes from
 * the server's own catalog.
 */

type Catalog =
  import("../../src/services/event-group-preset-service.js").PresetCatalog;

let catalog: Catalog = { entries: [], state: "ok" };
const actual = await import(
  "../../src/services/event-group-preset-service.js"
);
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
  buildGroupEditView,
  prepareGroupEditBody,
  PRESET_PICK_FIELD,
} = await import("../../src/web/host-settings-groups.js");
const { renderSettingsSection } = await import(
  "../../src/web/host-settings-view.js"
);
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
      name: 'Heli <b>"x"</b>',
      marker: "<i>",
      size: 2,
      memberCount: 3,
      overSize: true,
      namePending: false,
      sizePending: false,
    },
    {
      name: "Logi",
      marker: "",
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
  ...over,
});

describe("renderGroupEditor", () => {
  it("renders one name and one size field per group with the value it shows as the base", () => {
    const html = renderGroupEditor(view());
    expect(html).toContain('name="s_groupNameA"');
    expect(html).toContain('name="b_groupNameA"');
    expect(html).toContain('name="s_groupSizeA" value="2"');
    expect(html).toContain('name="b_groupSizeA" value="2"');
    expect(html).toContain('name="s_groupNameB"');
    // No size is shown as empty, and as an empty base.
    expect(html).toContain('name="s_groupSizeB" value=""');
    expect(html).toContain('name="b_groupSizeB" value=""');
    expect(html).toContain('maxlength="50"');
    expect(html).toContain('min="1" max="99"');
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
    expect(html).toContain('<form method="POST" action="/me/events/e/host/settings">');
    expect(html).toContain('name="_csrf" value="tok"');
    expect(html).toContain(`name="${PRESET_PICK_FIELD}"`);
    expect(html).toContain('<option value="">Keep the current groups</option>');
    expect(html).toContain('<option value="builtin:a">A &lt;script&gt;</option>');
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
    expect(html).toContain("No preset on this server fits this event's 2 groups.");
    expect(html).toContain("The library could not be read.");
    expect(html).not.toContain("<form");
  });
});

describe("the section puts the editor inside the settings form and the preset in its own", () => {
  it("renders both, and falls back to the read-only table without a group editor", () => {
    const base = {
      csrfToken: "tok",
      actionPath: (a: string) => `/p/${a}`,
      blocker: null,
      leadMinutes: null,
      leadReadOnly: null,
      locked: false,
      groupLabel: "Squad",
      groups: [
        { name: "G", marker: "", size: 1, memberCount: 0, overSize: false },
      ],
    };
    const withEditor = renderSettingsSection({ ...base, groupEdit: view() });
    const forms = withEditor.match(/<form /g) ?? [];
    expect(forms).toHaveLength(2);
    const first = withEditor.slice(0, withEditor.indexOf("</form>"));
    expect(first).toContain('name="s_groupNameA"');
    expect(first).not.toContain("preset_pick");
    expect(withEditor.slice(withEditor.indexOf("</form>"))).toContain(
      "preset_pick",
    );
    const plain = renderSettingsSection(base);
    expect(plain).not.toContain("s_groupNameA");
    expect(plain).toContain("prefs-table");
  });

  it("shows no editor while the section is blocked", () => {
    const html = renderSettingsSection({
      csrfToken: "t",
      actionPath: (a) => a,
      blocker: "Events are turned off",
      leadMinutes: null,
      leadReadOnly: null,
      locked: null,
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
      { name: "A", size: 1, memberCount: 2, overSize: true, namePending: true, sizePending: false },
      { name: "B", size: null, memberCount: 0, overSize: false, namePending: false },
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
      { s_channelLeadMinutes: "5", b_channelLeadMinutes: "", [PRESET_PICK_FIELD]: "" },
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
