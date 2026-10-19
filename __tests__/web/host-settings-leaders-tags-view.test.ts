import { describe, it, expect } from "@jest/globals";
import {
  leadersTagsViewOf,
  renderLeadersTagsFields,
} from "../../src/web/host-settings-leaders-tags-view.js";
import { renderSettingsSection } from "../../src/web/host-settings-view.js";

/**
 * The leaders and tags fields of the Live settings form (#1240): what each field
 * posts (a value and the value it showed), what is escaped, and when nothing is
 * shown. Expected strings are literals.
 */

const groups = [
  {
    key: "g_00000001",
    name: 'Red <img src=x onerror="1">',
    kind: "team",
    marker: "R&B",
    tag: " RED ",
  },
  { key: "g_00000002", name: "Open", kind: "open", marker: "", tag: "" },
  { key: "g_00000003", name: "Blue", kind: "team", marker: "", tag: null },
];

describe("leadersTagsViewOf", () => {
  it("is null for an event without groups", () => {
    expect(leadersTagsViewOf({ groupsEnabled: false, groups })).toBeNull();
    expect(leadersTagsViewOf({ groupsEnabled: true, groups: [] })).toBeNull();
  });

  it("reads the switches as stored, defaults the label and lists team groups only", () => {
    expect(
      leadersTagsViewOf({
        groupsEnabled: true,
        captainsEnabled: true,
        leaderLabel: "",
        tagsEnabled: true,
        tagsSuffix: true,
        groups,
      }),
    ).toEqual({
      leaders: true,
      customisation: false,
      leaderLabel: "Leader",
      tags: true,
      tagsSuffix: true,
      teams: [
        {
          key: "g_00000001",
          name: 'Red <img src=x onerror="1">',
          marker: "R&B",
          tag: "RED",
        },
        { key: "g_00000003", name: "Blue", marker: "", tag: "" },
      ],
    });
  });
});

describe("renderLeadersTagsFields", () => {
  const view = leadersTagsViewOf({
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: false,
    leaderLabel: 'Cap"tain',
    tagsEnabled: false,
    tagsSuffix: true,
    groups,
  });

  it("renders nothing without a view", () => {
    expect(renderLeadersTagsFields(null)).toBe("");
  });

  it("posts each field with the value it showed", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).toContain('name="s_captainsEnabled"');
    expect(html).toContain(
      '<input type="hidden" name="b_captainsEnabled" value="1">',
    );
    expect(html).toContain(
      '<input type="hidden" name="b_captainCustomisationEnabled" value="0">',
    );
    expect(html).toContain(
      '<input type="hidden" name="b_tagsEnabled" value="0">',
    );
    expect(html).toContain(
      '<input type="hidden" name="b_tagsSuffix" value="1">',
    );
    expect(html).toContain(
      '<input type="hidden" name="b_leaderLabel" value="Cap&quot;tain">',
    );
    expect(html).toContain(
      '<input type="hidden" name="b_groupTags_g_00000001" value="RED">',
    );
    expect(html).toContain('name="s_groupTags_g_00000001" value="RED"');
    expect(html).toContain('name="s_groupTags_g_00000003" value=""');
  });

  it("selects the stored option of each switch", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).toMatch(
      /name="s_captainsEnabled">\s*<option value="1" selected>/,
    );
    expect(html).toMatch(
      /name="s_captainCustomisationEnabled">\s*<option value="1">[^<]*<\/option>\s*<option value="0" selected>/,
    );
  });

  it("escapes names, markers and the label; a team name never reaches the page as markup", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "R&amp;B Red &lt;img src=x onerror=&quot;1&quot;&gt;",
    );
    expect(html).toContain('value="Cap&quot;tain"');
  });

  it("limits the tag input to the tag maximum and has no input for a non-team group", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).toContain('maxlength="8"');
    expect(html).not.toContain("s_groupTags_g_00000002");
  });

  it("is part of the Live settings form, inside the one form that posts to settings", () => {
    const page = renderSettingsSection({
      csrfToken: "tok",
      actionPath: (n) => `/me/events/e/host/${n}`,
      blocker: null,
      leadMinutes: null,
      leadReadOnly: null,
      locked: null,
      groupLabel: "Team",
      groups: [],
      leadersTags: view,
    });
    const form = page.slice(page.indexOf("<form"), page.indexOf("</form>"));
    expect(form).toContain("s_captainsEnabled");
    expect(form).toContain("s_groupTags_g_00000001");
    expect(form).toContain('action="/me/events/e/host/settings"');
  });

  it("is absent from the form when the section has no leaders and tags view", () => {
    const page = renderSettingsSection({
      csrfToken: "tok",
      actionPath: (n) => `/x/${n}`,
      blocker: null,
      leadMinutes: null,
      leadReadOnly: null,
      locked: null,
      groupLabel: "Team",
      groups: [],
    });
    expect(page).not.toContain("s_captainsEnabled");
  });
});
