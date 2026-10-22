/**
 * Unit tests for the `/me` layout (`src/web/user-layout.ts`) accessibility
 * conventions from #855: focus styling, skip link, aria-current, the live
 * region + focus behaviour of the post-redirect flash, contrast tokens, and
 * the glyph-only cases (default-preset star, hour bars).
 */

import { describe, it, expect } from "@jest/globals";
import {
  renderUserPage,
  renderUserIndexBody,
  renderUserVoiceBody,
  renderUserNotificationsBody,
  renderUserTimezoneBody,
  USER_NAV_ITEMS,
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
      rows: [
        {
          key: "digest",
          label: "Weekly digest",
          description: "A weekly DM.",
          enabled: true,
        },
      ],
    });
    expect(html).toContain(
      '<caption class="visually-hidden">Direct-message notification channels and whether each is on</caption>',
    );
    expect(html).toContain('<th scope="col">Notification</th>');
    expect(html).toContain('<th scope="col">Current state</th>');
    expect(html).not.toContain("<th>");
  });
});

// ---- /me only shows features that are switched on (#1292) -----------------

const SURFACES = [
  { flag: "presetsEnabled", href: "/me/voice", label: "Voice" },
  { flag: "birthdayEnabled", href: "/me/birthday", label: "Birthday" },
  { flag: "rewindEnabled", href: "/me/rewind", label: "Rewind" },
  { flag: "privacyEnabled", href: "/me/privacy", label: "Privacy" },
] as const;

const ALWAYS = ["/me/", "/me/notifications", "/me/timezone"];

function tabs(html: string): string[] {
  const nav = html.match(/<nav class="page-nav"[^>]*>(.*?)<\/nav>/s)?.[1] ?? "";
  return [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

function overview(flags: Record<string, boolean> = {}): string {
  return renderUserIndexBody({
    discordUserId: "u1",
    guildId: "g1",
    isAdmin: false,
    ...flags,
  });
}

describe("tabs leave out a switched-off feature (#1292)", () => {
  it("shows every tab when nothing says a feature is off", () => {
    expect(tabs(render())).toEqual(USER_NAV_ITEMS.map((i) => i.href));
  });

  it.each(SURFACES)("drops $label when $flag is false, keeps the rest", (s) => {
    const html = render({ [s.flag]: false });
    const hrefs = tabs(html);
    expect(hrefs).not.toContain(s.href);
    expect(html).not.toContain(`>${s.label}</a>`);
    for (const other of [
      ...ALWAYS,
      ...SURFACES.filter((o) => o !== s).map((o) => o.href),
    ]) {
      expect(hrefs).toContain(other);
    }
  });

  it("carries no off badge, dashed pill or tooltip for anything", () => {
    const html = render({
      presetsEnabled: false,
      birthdayEnabled: false,
      rewindEnabled: false,
      privacyEnabled: false,
    });
    expect(html).not.toContain("nav-badge");
    expect(html).not.toContain("nav-disabled");
    expect(html).not.toContain("hasn't enabled");
    expect(tabs(html)).toEqual(ALWAYS);
  });
});

describe("overview leaves out a switched-off feature (#1292)", () => {
  it("lists every card when nothing says a feature is off", () => {
    const html = overview();
    for (const s of SURFACES) expect(html).toContain(`href="${s.href}"`);
  });

  it.each(SURFACES)("omits the $label card when $flag is false", (s) => {
    const html = overview({ [s.flag]: false });
    expect(html).not.toContain(`href="${s.href}"`);
    expect(html).not.toContain("tag-off");
    for (const other of SURFACES.filter((o) => o !== s)) {
      expect(html).toContain(`href="${other.href}"`);
    }
  });

  it("keeps the cards that are not gated", () => {
    const html = overview({
      presetsEnabled: false,
      birthdayEnabled: false,
      rewindEnabled: false,
      privacyEnabled: false,
    });
    expect(html).toContain('href="/me/notifications"');
    expect(html).toContain('href="/me/timezone"');
  });
});

describe("copy does not name a feature that is off (#1292)", () => {
  it("drops the Rewind sentence from the poll card, and keeps it while Rewind is on", () => {
    const poll = {
      totalVotes: 3,
      thisYearVotes: 2,
      lastVoted: null,
    };
    const off = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      rewindEnabled: false,
      pollParticipation: poll,
    });
    expect(off).toContain("Poll participation");
    expect(off).not.toMatch(/rewind/i);
    const on = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      pollParticipation: poll,
    });
    expect(on).toContain("yearly tally on Rewind");
  });

  it("does not name Rewind or digests on the timezone card or page", () => {
    expect(overview({ rewindEnabled: false })).not.toMatch(/rewind/i);
    const page = renderUserTimezoneBody({
      csrfToken: "c",
      zones: ["Europe/Oslo"],
      selected: null,
      serverTimezone: "UTC",
    });
    expect(page).not.toMatch(/rewind|digest/i);
  });
});

describe("notifications page with nothing to offer (#1292)", () => {
  it("says so and renders no form or Save button", () => {
    const html = renderUserNotificationsBody({ csrfToken: "c", rows: [] });
    expect(html).toContain("kb-empty__title");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Save preferences");
  });
});
