/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * The dependency block of the Setup wizard's Review step (#1622): the confirm
 * Switch's accessible name and the text a blocker gives the admin.
 */

import { describe, it, expect } from "@jest/globals";
import { renderDependencyReview } from "../../src/web/wizard-dependencies-view.js";

function mount(html: string): void {
  document.body.innerHTML = html;
}

/**
 * The accessible name a browser computes for a control, reduced to the two
 * sources this markup uses: `aria-labelledby` (which wins) and a wrapping
 * `<label>`.
 */
function accessibleName(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (ids) {
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  return el.closest("label")?.textContent?.trim() ?? "";
}

describe("renderDependencyReview", () => {
  const cascade = {
    cascade: [
      {
        key: "voicetracking.enabled",
        dependents: ["voicetracking.announcements.enabled"],
      },
    ],
    cascadeKeys: ["voicetracking.announcements.enabled"],
    fingerprint: "voicetracking.announcements.enabled",
    blockers: [],
  };

  it("names the confirm Switch by its visible label (WCAG 2.5.3)", () => {
    mount(renderDependencyReview(cascade));
    const input = document.querySelector('input[name="cascadeOff"]');
    expect(input).not.toBeNull();
    const visible = input?.closest("label")?.textContent?.trim() ?? "";
    expect(visible).toBe("Turn it off too");
    expect(accessibleName(input as Element)).toContain(visible);
    // The settings list is the description, not the name.
    const described = input?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toContain(
      "voicetracking.announcements.enabled",
    );
  });

  it("tells the admin what works when a required feature was not chosen", () => {
    mount(
      renderDependencyReview({
        cascade: [],
        cascadeKeys: [],
        fingerprint: "",
        blockers: [
          {
            key: "achievements.enabled",
            direction: "enable",
            related: ["voicetracking.enabled"],
          },
        ],
      }),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("turning it on in All settings does not help");
    expect(text).toContain("Apply turns off every feature that was not chosen");
    expect(text).toContain("choose it on the first step");
    expect(text).toContain("leave it off");
    expect(text).not.toContain("`");
    const links = Array.from(document.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("/admin/wizard?reset=1");
    expect(links).toContain("/admin/settings#section-voicetracking");
  });
});
