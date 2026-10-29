/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * One primary button per view (#1512).
 *
 * DESIGN.md, Principles 10: "One job, one primary button. Each view has at
 * most one `primary` button." This guard parses every page in `a11y-pages.ts`
 * and counts the buttons in the primary fill (`btn-primary` in the admin and
 * member layouts, `kb-btn--primary` on the kb- components).
 *
 * What does not count:
 * - a button inside a `dialog` or a toolbar panel (`.kb-toolbar__panel`): it
 *   belongs to the question that dialog asks, not to the page;
 * - a save bar inside a feature page's folded Settings (`details[data-settings-fold]`):
 *   the fold has its own form and its own save.
 *
 * The save bars of the All settings page (one per section) count as one: the
 * page is the save bar, and the legacy buttons beside it are neutral.
 */

import { describe, it, expect } from "@jest/globals";
import { allPages } from "./a11y-pages.js";

const PRIMARY = ".btn-primary, .kb-btn--primary";

function label(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The primary buttons that count against the page, one string each. */
function countedPrimaries(doc: Document): string[] {
  const counted: string[] = [];
  let saveBars = 0;
  doc.querySelectorAll(PRIMARY).forEach((b) => {
    if (b.closest("dialog, .kb-toolbar__panel")) return;
    if (b.closest(".kb-savebar")) {
      if (b.closest("details[data-settings-fold]")) return;
      saveBars += 1;
      return;
    }
    counted.push(label(b));
  });
  if (saveBars > 0) counted.push("(save bar)");
  return counted;
}

describe("One primary button per view (#1512)", () => {
  it("counts a second primary but not one in a dialog, a toolbar panel or a folded save bar", () => {
    const parse = (html: string): Document =>
      new DOMParser().parseFromString(html, "text/html");
    expect(
      countedPrimaries(
        parse(
          '<a class="kb-btn kb-btn--primary">One</a><button class="btn btn-primary">Two</button>',
        ),
      ),
    ).toEqual(["One", "Two"]);
    expect(
      countedPrimaries(
        parse(
          '<a class="kb-btn kb-btn--primary">One</a>' +
            '<dialog><button class="kb-btn kb-btn--primary">In dialog</button></dialog>' +
            '<div class="kb-toolbar__panel"><button class="kb-btn kb-btn--primary">In panel</button></div>' +
            '<details data-settings-fold><div class="kb-savebar"><button class="kb-btn kb-btn--primary">Save</button></div></details>',
        ),
      ),
    ).toEqual(["One"]);
    expect(
      countedPrimaries(
        parse(
          '<form><div class="kb-savebar"><button class="kb-btn kb-btn--primary">Save</button></div></form>' +
            '<form><div class="kb-savebar"><button class="kb-btn kb-btn--primary">Save</button></div></form>',
        ),
      ),
    ).toEqual(["(save bar)"]);
    expect(
      countedPrimaries(
        parse(
          '<button class="btn btn-primary">Create</button><div class="kb-savebar"><button class="kb-btn kb-btn--primary">Save</button></div>',
        ),
      ),
    ).toEqual(["Create", "(save bar)"]);
  });

  for (const page of allPages()) {
    it(`${page.name} has at most one primary button`, () => {
      const doc = new DOMParser().parseFromString(page.html, "text/html");
      const counted = countedPrimaries(doc);
      expect(counted.length <= 1 ? [] : counted).toEqual([]);
    });
  }
});
