import { describe, it, expect } from "@jest/globals";
import { renderCustomiseSection } from "../../src/web/host-customise-view.js";

const base = {
  csrfToken: "tok<en>",
  actionPath: (n: string) => `/me/events/e1/host/${n}`,
  on: true,
  groupLabel: "Squad",
  leaderLabel: "Captain",
  teams: [],
  edits: [],
};

describe("renderCustomiseSection (#1196)", () => {
  it("escapes every dynamic value", () => {
    const html = renderCustomiseSection({
      ...base,
      teams: [
        {
          key: "g_00000001",
          name: "<img src=x onerror=1>",
          marker: "<b>",
          tag: '"><x>',
          originalName: "<script>a</script>",
          originalTag: "'><y>",
          renamePending: true,
        },
      ],
      edits: [
        {
          at: "2030-01-01T00:00:00.000Z",
          who: "<i>Ana</i>",
          text: 'name "<u>" to "x"',
        },
      ],
    });
    for (const raw of ["<img", "<script", "<i>", "<u>", "<b>", "<x>", "<y>"]) {
      expect(html).not.toContain(raw);
    }
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("&lt;i&gt;Ana&lt;/i&gt;");
    expect(html).toContain("channel rename pending");
  });

  it("every form carries the CSRF token (escaped) and posts to reset-team with the team key only", () => {
    const html = renderCustomiseSection({
      ...base,
      teams: [
        {
          key: "g_00000001",
          name: "A",
          marker: "",
          tag: "",
          originalName: "B",
          originalTag: "",
          renamePending: false,
        },
        {
          key: "g_00000002",
          name: "C",
          marker: "",
          tag: "",
          originalName: null,
          originalTag: "",
          renamePending: false,
        },
      ],
    });
    const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('action="/me/events/e1/host/reset-team"');
    expect(forms[0]).toContain('name="_csrf" value="tok&lt;en&gt;"');
    expect(forms[0]).toContain('name="group" value="g_00000001"');
    expect(html).toContain("Not changed");
  });

  it("says what leaders can do, or that they cannot, in the event's own words", () => {
    expect(renderCustomiseSection(base)).toContain("Customise team");
    expect(renderCustomiseSection(base)).toContain("captain");
    const off = renderCustomiseSection({ ...base, on: false });
    expect(off).toContain("cannot customise");
    expect(off).toContain("kept until you reset them");
  });

  it("handles no teams and no edits", () => {
    const html = renderCustomiseSection(base);
    expect(html).toContain("This event has no teams.");
    expect(html).toContain("has changed a squad yet");
  });
});
