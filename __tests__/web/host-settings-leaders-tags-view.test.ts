import { describe, it, expect } from "@jest/globals";
import {
  leadersTagsViewOf,
  renderLeadersTagsFields,
} from "../../src/web/host-settings-leaders-tags-view.js";
import { renderEventSettings } from "../../src/web/host-settings-view.js";

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
      lobby: false,
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
    expect(html).toContain(
      'name="s_captainsEnabled">\n<option value="1" selected>On: each team can have a leader</option>',
    );
    expect(html).toContain(
      'name="s_captainCustomisationEnabled">\n<option value="1">On</option>\n<option value="0" selected>Off</option>',
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

  it("nests the leader label, customisation and lobby under Leaders, and the tag position and team tags under Clan tags", () => {
    const html = renderLeadersTagsFields(view);
    const leaders = html.slice(
      html.indexOf("<legend>Leaders</legend>"),
      html.indexOf("<legend>Clan tags</legend>"),
    );
    const tags = html.slice(html.indexOf("<legend>Clan tags</legend>"));
    const nestedOf = (part: string): string => {
      const i = part.indexOf('<div class="kb-nested"');
      expect(i).toBeGreaterThan(0);
      return part.slice(i);
    };
    // The parent switch sits above its children, never inside them.
    expect(leaders.indexOf('name="s_captainsEnabled"')).toBeLessThan(
      leaders.indexOf('<div class="kb-nested"'),
    );
    const lc = nestedOf(leaders);
    for (const name of [
      "s_leaderLabel",
      "s_captainCustomisationEnabled",
      "s_captainsLobby",
    ]) {
      expect(lc).toContain(`name="${name}"`);
    }
    expect(lc).not.toContain('name="s_captainsEnabled"');
    expect(tags.indexOf('name="s_tagsEnabled"')).toBeLessThan(
      tags.indexOf('<div class="kb-nested"'),
    );
    const tc = nestedOf(tags);
    expect(tc).toContain('name="s_tagsSuffix"');
    expect(tc).toContain("s_groupTags_g_00000001");
    expect(tc).not.toContain('name="s_tagsEnabled"');
    // Every field name is still posted by the one form.
    expect(html).toContain('name="b_tagsEnabled"');
  });

  describe("the Captains lobby switch (#1251)", () => {
    const viewWith = (
      over: Record<string, unknown>,
      lobby: boolean,
    ): ReturnType<typeof leadersTagsViewOf> =>
      leadersTagsViewOf({
        groupsEnabled: true,
        captainsEnabled: true,
        groups: lobby
          ? [...groups, { key: "g_000000a1", name: "Command", kind: "leads" }]
          : groups,
        ...over,
      });

    it("is derived from a leads group and posts its value with the value it showed", () => {
      expect(viewWith({}, false)?.lobby).toBe(false);
      expect(viewWith({}, true)?.lobby).toBe(true);
      const off = renderLeadersTagsFields(viewWith({}, false));
      expect(off).toContain('name="s_captainsLobby"');
      expect(off).toContain(
        '<input type="hidden" name="b_captainsLobby" value="0">',
      );
      expect(off).toContain(
        '<option value="0" selected>Off: leaders talk in the main channel</option>',
      );
      const on = renderLeadersTagsFields(viewWith({}, true));
      expect(on).toContain(
        '<input type="hidden" name="b_captainsLobby" value="1">',
      );
      expect(on).toContain(
        '<option value="1" selected>On: a leaders-only voice channel</option>',
      );
    });

    it("is usable while leaders are off, so both can be turned on in one save, and says so", () => {
      const html = renderLeadersTagsFields(
        viewWith({ captainsEnabled: false }, false),
      );
      expect(html).not.toContain('name="s_captainsLobby" disabled');
      expect(html).toContain("in this same save is fine");
    });

    it("can still be turned off while leaders are off", () => {
      const html = renderLeadersTagsFields(
        viewWith({ captainsEnabled: false }, true),
      );
      expect(html).not.toContain('name="s_captainsLobby" disabled');
      expect(html).toContain("Leaders are off, so only you can join");
    });

    it("never lists the lobby's group name or makes a tag field for it", () => {
      const html = renderLeadersTagsFields(viewWith({}, true));
      expect(html).not.toContain("Command");
      expect(html).not.toContain("s_groupTags_g_000000a1");
    });
  });

  it("limits the tag input to the tag maximum and has no input for a non-team group", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).toContain('maxlength="8"');
    expect(html).not.toContain("s_groupTags_g_00000002");
  });

  it("is part of the Event settings form, inside the one form that posts to settings", () => {
    const page = renderEventSettings({
      csrfToken: "tok",
      actionPath: (n) => `/me/events/e/host/${n}`,
      blocker: null,
      leadMinutes: null,
      leadReadOnly: null,
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
    const page = renderEventSettings({
      csrfToken: "tok",
      actionPath: (n) => `/x/${n}`,
      blocker: null,
      leadMinutes: null,
      leadReadOnly: null,
      groupLabel: "Team",
      groups: [],
    });
    expect(page).not.toContain("s_captainsEnabled");
  });
});
