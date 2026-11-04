import { describe, it, expect } from "@jest/globals";
import { renderWizardConfirmPage } from "../../src/web/admin-views.js";
import {
  renderCreateReview,
  type PlannedCreation,
} from "../../src/web/wizard-create-review.js";

const text: PlannedCreation = {
  kind: "text",
  name: "quotes",
  settingLabel: "Quotes channel",
  parent: { name: "Community" },
};
const voice: PlannedCreation = {
  kind: "voice",
  name: "Lobby",
  settingLabel: "Lobby channel",
  parent: null,
};
const category: PlannedCreation = {
  kind: "category",
  name: "Hangout",
  settingLabel: "Voice category",
};

/** The visible text of a fragment: tags dropped, svg labels not included. */
function plain(html: string): string {
  return html
    .replace(/<svg[^>]*>.*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("renderCreateReview (#1661)", () => {
  it("draws nothing when no channel or category is planned", () => {
    expect(renderCreateReview([])).toBe("");
  });

  it("describes a text channel with its parent and inherited access", () => {
    const html = renderCreateReview([text]);
    expect(plain(html)).toContain(
      "Create the text channel quotes for Quotes channel",
    );
    expect(plain(html)).toContain("In Community");
    expect(plain(html)).toContain("Inherits access from Community");
    expect(html).toContain('aria-label="Text channel"');
    expect(html).toContain('aria-label="Category"');
  });

  it("describes a voice channel outside any category", () => {
    const html = renderCreateReview([voice]);
    expect(plain(html)).toContain(
      "Create the voice channel Lobby for Lobby channel",
    );
    expect(plain(html)).toContain("Not in a category");
    expect(plain(html)).toContain("Visible to everyone who can see the server");
    expect(html).toContain('aria-label="Voice channel"');
    expect(html).not.toContain("Inherits access");
  });

  it("describes a category as a category mention, never with a hash", () => {
    const html = renderCreateReview([category]);
    expect(plain(html)).toContain(
      "Create the category Hangout for Voice category",
    );
    expect(html).toContain("kb-mention kb-mention--category");
    expect(plain(html)).toContain("Visible to everyone who can see the server");
    expect(plain(html)).not.toContain("#");
  });

  it("says nothing is created until apply and what a failed apply leaves", () => {
    const html = renderCreateReview([text, voice, category]);
    expect(plain(html)).toContain("Nothing is created until you apply.");
    expect(plain(html)).toContain(
      "If applying fails, KoolBot removes what it created; anything it keeps because something now points at it, or could not remove, is named.",
    );
    expect(html.match(/<li>/g)).toHaveLength(3);
  });

  it("is plain text only: no markdown characters in the sentences", () => {
    const text = plain(renderCreateReview([voice, category]));
    expect(text).not.toMatch(/[*_`]|\[.*\]\(/);
  });

  it("escapes every name and label", () => {
    const html = renderCreateReview([
      {
        kind: "text",
        name: "<img src=x onerror=1>",
        settingLabel: "<b>label</b>",
        parent: { name: "<script>x</script>" },
      },
      { kind: "category", name: '"><svg onload=1>', settingLabel: "a&b" },
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("a&amp;b");
  });
});

describe("renderWizardConfirmPage, planned creations (#1661)", () => {
  const props = {
    csrfToken: "tok",
    remainingMs: 60_000,
    pending: [] as Array<[string, unknown]>,
    metadata: {},
  };

  it("lists the creations on Review and leaves Apply enabled", () => {
    const html = renderWizardConfirmPage({
      ...props,
      creations: [text, category],
    });
    expect(html).toContain("Create the text channel");
    expect(html).toContain("Nothing is created until you apply.");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
  });

  it("changes nothing when there are none", () => {
    const html = renderWizardConfirmPage({ ...props, creations: [] });
    expect(html).not.toContain("Nothing is created until you apply.");
  });
});

describe("the voice category's Review line (#1664)", () => {
  it("adds the note under a category, and only when given", () => {
    const withNote = renderCreateReview([
      {
        kind: "category",
        name: "Gaming",
        settingLabel: "Managed category",
        note: "The lobby is created in it by the voice feature, not by this step.",
      },
    ]);
    expect(plain(withNote)).toContain(
      "Visible to everyone who can see the server. The lobby is created in it by the voice feature, not by this step.",
    );
    expect(plain(renderCreateReview([category]))).not.toContain("lobby");
  });

  it("escapes the note", () => {
    const html = renderCreateReview([
      {
        kind: "category",
        name: "x",
        settingLabel: "y",
        note: "<b>hi</b>",
      },
    ]);
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });
});
