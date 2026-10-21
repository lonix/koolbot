/**
 * Unit tests for the `/me` layout (`src/web/user-layout.ts`) accessibility
 * conventions from #855: focus styling, skip link, aria-current, the live
 * region + focus behaviour of the post-redirect flash, contrast tokens, and
 * the glyph-only cases (default-preset star, hour bars).
 */

import { describe, it, expect } from "@jest/globals";
import {
  renderUserPage,
  renderUserVoiceBody,
  renderUserNotificationsBody,
} from "../../src/web/user-layout.js";

function render(overrides: Partial<Parameters<typeof renderUserPage>[0]> = {}) {
  return renderUserPage({
    title: "Overview",
    active: "/me/",
    body: "<h1>Hi</h1>",
    csrfToken: "csrf",
    remainingMs: 60_000,
    isAdmin: false,
    ...overrides,
  });
}

describe("renderUserPage accessibility (#855)", () => {
  it("ships a focus ring, a skip link and aria-current on the active nav pill", () => {
    const html = render({ active: "/me/timezone" });
    expect(html).toContain(
      "a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}",
    );
    expect(html).toContain(
      ".page-nav a:focus-visible{background:var(--chrome)",
    );
    expect(html).toMatch(
      /<body><a class="skip-link" href="#main">Skip to content<\/a>/,
    );
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(html).toContain(
      '<a href="/me/timezone" class="active" aria-current="page">Timezone</a>',
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("renders the flash as a focusable live region and focuses it on load", () => {
    const html = render({ flash: { type: "ok", text: "Preferences saved." } });
    expect(html).toContain(
      '<div class="notice ok" role="status" tabindex="-1" data-flash>Preferences saved.</div>',
    );
    expect(html).toContain(
      "var n=document.querySelector('.notice[data-flash]');if(!n)return;try{n.focus()}catch(e){}",
    );
  });

  it("uses colours that clear the WCAG contrast floors", () => {
    const html = render();
    // Sign out is the neutral kb-btn of the shared top bar (no hard-coded colour here).
    expect(html).toContain(
      '<button type="submit" class="kb-btn kb-btn--sm">Sign out</button>',
    );
    expect(html).not.toContain("#ef4444");
    expect(html).not.toContain("#6b7280");
    // --control survives only as the control border, never as text.
    expect(html).not.toContain("color:var(--control)");
    expect(html).toContain(
      "border:1px solid var(--control);border-radius:4px;padding:.45rem .5rem",
    );
    expect(html).toContain(
      ".preset-grid input{background:var(--bg);color:var(--text);border:1px solid var(--control);",
    );
  });

  it("tightens gutters on narrow viewports and scrolls wide content inside main", () => {
    const html = render();
    expect(html).toContain("@media (max-width:760px){main{padding:1rem}");
    expect(html).toContain("max-width:64rem;min-width:0;overflow-x:auto}");
  });
});

describe("renderUserVoiceBody (#855)", () => {
  it("says 'Default' in words rather than a bare star", () => {
    const html = renderUserVoiceBody({
      csrfToken: "csrf",
      namePattern: null,
      displayName: "Alice",
      presets: [
        {
          index: 0,
          name: "Chill",
          channelName: null,
          userLimit: null,
          bitrate: null,
          isDefault: true,
        },
        {
          index: 1,
          name: "Ranked",
          channelName: null,
          userLimit: 5,
          bitrate: null,
          isDefault: false,
        },
      ],
      maxPerUser: 5,
      featureEnabled: true,
    });
    expect(html).toContain(
      '<h2>Chill <span class="pill"><span aria-hidden="true">⭐</span> Default</span></h2>',
    );
    expect(html).toContain("<h2>Ranked</h2>");
  });
});

describe("renderUserNotificationsBody (#855)", () => {
  it("gives the preferences table a caption and scoped column headers", () => {
    const html = renderUserNotificationsBody({
      csrfToken: "csrf",
      rows: [],
    });
    expect(html).toContain(
      '<caption class="visually-hidden">Direct-message notification channels and whether each is on</caption>',
    );
    expect(html).toContain('<th scope="col">Notification</th>');
    expect(html).toContain('<th scope="col">Current state</th>');
    expect(html).not.toContain("<th>");
  });
});
