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
    // The team tags moved to the group rows (#1406): not posted from here.
    expect(html).not.toContain("groupTags");
  });

  it("renders each boolean as a switch that posts 1 while on, ticked as stored, and no Off/On select", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<option");
    const input = (name: string): string =>
      html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
    // Leaders are on, customisation off, clan tags off, no lobby.
    expect(input("s_captainsEnabled")).toContain('role="switch"');
    expect(input("s_captainsEnabled")).toContain('value="1" checked');
    expect(input("s_captainCustomisationEnabled")).toContain('value="1"');
    expect(input("s_captainCustomisationEnabled")).not.toContain("checked");
    expect(input("s_tagsEnabled")).not.toContain("checked");
    expect(input("s_captainsLobby")).not.toContain("checked");
    // Where the tag goes is a segmented control showing the result; suffix is stored.
    expect(html).toContain('<div class="kb-segmented" role="radiogroup"');
    expect(html).toContain(
      '<input type="radio" id="host-settings-tagsSuffix-input-0" name="s_tagsSuffix" value="0"><span>[RED] Alice</span>',
    );
    expect(html).toContain(
      'name="s_tagsSuffix" value="1" checked><span>Alice [RED]</span>',
    );
  });

  it("is built from SettingRows with one line each and the rest behind an inline More", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).toContain('<p class="kb-overline">Group leaders</p>');
    expect(html).toContain('<p class="kb-overline">Clan tags</p>');
    expect(html.match(/class="kb-setting"/g)?.length).toBe(6);
    expect(html).not.toContain('class="muted"');
    expect(html).not.toContain('class="field"');
    expect(html).toContain(
      '<details class="kb-disclosure kb-disclosure--inline">',
    );
    // What happens without a confirmation stays on the page, behind More.
    expect(html).toContain("Turning leaders off hides the Leaders section");
  });

  it("escapes the label; a team name never reaches the page as markup (the team tags are in the group rows now)", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).toContain('value="Cap&quot;tain"');
  });

  it("nests the leader label, customisation and lobby under Leaders, and the tag position under Clan tags, with a pointer to the team tags", () => {
    const html = renderLeadersTagsFields(view);
    const leaders = html.slice(
      html.indexOf("Group leaders</p>"),
      html.indexOf("Clan tags</p>"),
    );
    const tags = html.slice(html.indexOf("Clan tags</p>"));
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
    expect(tc).toContain("under &quot;Change the groups&quot;");
    expect(tc).not.toContain("s_groupTags_");
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
      expect(off).not.toMatch(/name="s_captainsLobby"[^>]*checked/);
      const on = renderLeadersTagsFields(viewWith({}, true));
      expect(on).toContain(
        '<input type="hidden" name="b_captainsLobby" value="1">',
      );
      expect(on).toMatch(/name="s_captainsLobby" value="1" checked/);
    });

    it("is usable while leaders are off, so both can be turned on in one save, and says so", () => {
      const html = renderLeadersTagsFields(
        viewWith({ captainsEnabled: false }, false),
      );
      // Enabled on purpose: a disabled switch posts nothing, and the server lets
      // the lobby be switched on in the same save as leaders.
      expect(html).not.toMatch(/name="s_captainsLobby"[^>]*disabled/);
      expect(html).toContain("switching both on in this save is fine");
    });

    it("can still be turned off while leaders are off", () => {
      const html = renderLeadersTagsFields(
        viewWith({ captainsEnabled: false }, true),
      );
      expect(html).not.toMatch(/name="s_captainsLobby"[^>]*disabled/);
      expect(html).toContain("Leaders are off, so only you can join");
    });

    it("never lists the lobby's group name or makes a tag field for it", () => {
      const html = renderLeadersTagsFields(viewWith({}, true));
      expect(html).not.toContain("Command");
      expect(html).not.toContain("s_groupTags_g_000000a1");
    });
  });

  it("has no tag input at all: a team's tag is edited in its group row, so it has one place on the panel", () => {
    const html = renderLeadersTagsFields(view);
    expect(html).not.toContain("s_groupTags_");
    expect(html).not.toContain("b_groupTags_");
    expect(html).not.toContain('placeholder="no tag"');
  });

  it("points to the group rows only when the event has a team", () => {
    const noTeam = leadersTagsViewOf({
      groupsEnabled: true,
      groups: [groups[1]],
    });
    expect(renderLeadersTagsFields(noTeam)).not.toContain(
      "under &quot;Change the groups&quot;",
    );
    expect(renderLeadersTagsFields(view)).toContain(
      "under &quot;Change the groups&quot;",
    );
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
    expect(form).not.toContain("s_groupTags_");
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
