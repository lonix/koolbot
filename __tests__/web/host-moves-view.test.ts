import { describe, it, expect } from "@jest/globals";
import {
  renderMovesSection,
  type MovesViewData,
} from "../../src/web/host-moves-view.js";

const data = (over: Partial<MovesViewData> = {}): MovesViewData => ({
  csrfToken: "tok<en>",
  actionPath: (n) => `/x/${n}`,
  blocker: null,
  sendableGroups: 1,
  waitingForChannel: 0,
  hasMain: true,
  groupLabel: "Team",
  destinations: [
    { value: "main", label: "Main channel", occupants: 1, limit: 0 },
    { value: "g_a", label: "Reds <b>", occupants: 2, limit: 2 },
    { value: "g_b", label: "Blues", occupants: 1, limit: 3 },
  ],
  people: [{ id: "1", name: "Ana <i>", where: "Main channel" }],
  ...over,
});

describe("moves section", () => {
  it("escapes values and carries the CSRF token in every form", () => {
    const html = renderMovesSection(data());
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("Reds &lt;b&gt;");
    expect(html).toContain("Ana &lt;i&gt;");
    expect(html.match(/name="_csrf" value="tok&lt;en&gt;"/g)).toHaveLength(3);
  });

  it("marks a full destination disabled and shows the fill", () => {
    const html = renderMovesSection(data());
    expect(html).toMatch(/<option value="g_a" disabled>[^<]*2\/2, full\)/);
    expect(html).toMatch(/<option value="g_b">[^<]*\(1\/3\)/);
    expect(html).toMatch(/<option value="main">[^<]*\(1\)/);
  });

  it("disables every button and says why when the bot cannot move members", () => {
    const html = renderMovesSection(data({ blocker: "No Move Members." }));
    expect(html).toContain("No Move Members.");
    expect(html.match(/<button[^>]* disabled /g)).toHaveLength(3);
    expect(html).toContain('aria-describedby="moves-blocker"');
    expect(html).toContain('id="moves-blocker"');
  });

  it("explains a disabled button for each missing precondition", () => {
    const html = renderMovesSection(
      data({
        sendableGroups: 0,
        hasMain: false,
        people: [],
        destinations: [],
      }),
    );
    expect(html).toContain('id="moves-send-why"');
    expect(html).toContain('id="moves-return-why"');
    expect(html).toContain('id="moves-one-why"');
    expect(html.match(/<button[^>]* disabled /g)).toHaveLength(3);
  });

  it("mentions people waiting for a channel", () => {
    expect(renderMovesSection(data({ waitingForChannel: 2 }))).toContain(
      "2 assigned people are in a team without a channel yet",
    );
  });

  it("says that moving never changes assignment", () => {
    expect(renderMovesSection(data())).toContain(
      "never changes which team they are assigned to",
    );
  });
});
