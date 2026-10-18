import { describe, it, expect } from "@jest/globals";
import {
  renderLeadersSection,
  type LeadersViewData,
} from "../../src/web/host-leaders-view.js";

function data(over: Partial<LeadersViewData> = {}): LeadersViewData {
  return {
    csrfToken: 'tok"en',
    actionPath: (name) => `/me/events/e1/host/${name}`,
    leaderLabel: "Captain",
    groupLabel: "Squad",
    blocker: null,
    defaultWhere: "the main channel.",
    destinations: [
      { value: "default", label: "Default" },
      { value: "g_a", label: "<b>Reds</b>" },
    ],
    groups: [
      {
        key: "g_a",
        name: "<b>Reds</b>",
        marker: "🔴",
        leaderId: "2",
        members: [
          { id: "1", name: "Ana <script>" },
          { id: "2", name: "Ben" },
        ],
      },
      { key: "g_b", name: "Blues", marker: "", leaderId: null, members: [] },
    ],
    ...over,
  };
}

describe("renderLeadersSection", () => {
  it("escapes every dynamic value and puts the CSRF token in every form", () => {
    const html = renderLeadersSection(data());
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Reds</b>");
    expect(html).toContain("&lt;b&gt;Reds&lt;/b&gt;");
    expect(html).toContain("Ana &lt;script&gt;");
    const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? [];
    // One picker (the empty group has none), the rename and the pull.
    expect(forms).toHaveLength(3);
    for (const f of forms) {
      expect(f).toContain('name="_csrf" value="tok&quot;en"');
    }
  });

  it("preselects the current leader and offers 'no captain' (the event's label)", () => {
    const html = renderLeadersSection(data());
    expect(html).toContain('<option value="2" selected>Ben</option>');
    expect(html).toContain('<option value="">No captain</option>');
    expect(html).toContain("Pull captains only");
  });

  it("says a group without members has nobody to pick", () => {
    const html = renderLeadersSection(data());
    expect(html).toContain("Nobody is in this squad yet");
  });

  it("disables the pull and explains why when a blocker is given", () => {
    const html = renderLeadersSection(
      data({ blocker: "The bot lacks Move Members." }),
    );
    expect(html).toContain('id="leaders-blocker"');
    expect(html).toMatch(
      /<button class="btn" type="submit" disabled aria-disabled="true" aria-describedby="leaders-blocker">Pull captains<\/button>/,
    );
    expect(renderLeadersSection(data())).not.toContain("disabled");
  });

  it("handles an event with no team group", () => {
    const html = renderLeadersSection(data({ groups: [] }));
    expect(html).toContain("no team groups");
  });
});
