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
  renderUserPrivacyBody,
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
    expect(html).not.toContain("page-nav");
    expect(html).toMatch(
      /<body><a class="skip-link" href="#main">Skip to content<\/a>/,
    );
    expect(html).toContain('<main id="main" tabindex="-1">');
    // Tabs component (components.md): nav.kb-tabs, still told apart from the
    // Rewind year picker by its label.
    expect(html).toContain(
      '<nav class="kb-tabs" aria-label="My preferences sections">',
    );
    expect(html).toContain(
      '<a href="/me/timezone" aria-current="page">Timezone</a>',
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

describe("renderUserNotificationsBody (#1508)", () => {
  const html = renderUserNotificationsBody({
    csrfToken: "csrf",
    rows: [
      {
        key: "digest",
        label: "Weekly digest",
        description: "A weekly DM.",
        enabled: true,
      },
      {
        key: "achievements",
        label: "Achievement DMs",
        description: "A DM per badge.",
        enabled: false,
      },
    ],
  });

  it("lists each message as a SettingRow with a named switch, not a table", () => {
    expect(html).toContain('<div class="kb-settings">');
    expect(html.match(/<div class="kb-setting">/g)).toHaveLength(2);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Current state");
    expect(html).not.toContain("Enabled");
    expect(html).toContain(
      '<p class="kb-setting__name" id="notify-digest-name">Weekly digest</p>',
    );
    expect(html).toContain('aria-labelledby="notify-digest-name"');
    expect(html).toContain('aria-describedby="notify-digest-desc"');
  });

  it("posts value=true when on, so the submitted_<key> handling is unchanged", () => {
    expect(html).toContain(
      '<input type="checkbox" role="switch" name="digest" value="true" checked',
    );
    expect(html).toMatch(
      /<input type="checkbox" role="switch" name="achievements" value="true" aria-labelledby/,
    );
    expect(html).toContain(
      '<input type="hidden" name="submitted_digest" value="1">',
    );
    expect(html).toContain(
      '<input type="hidden" name="submitted_achievements" value="1">',
    );
  });

  it("says what happens, without 'Untoggling'", () => {
    expect(html).toContain(
      "Switch a message off and save, and the bot stops sending it.",
    );
    expect(html).not.toMatch(/untoggl/i);
    expect(html).toContain("KoolBot may send you");
    expect(html).not.toContain("Koolbot");
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
  const nav = html.match(/<nav class="kb-tabs"[^>]*>(.*?)<\/nav>/s)?.[1] ?? "";
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

describe("privacy page does not link to Rewind while it is off (#1292)", () => {
  const base = {
    featureEnabled: true,
    included: [],
    excluded: [],
    maxItems: 100,
    reset: { enabled: false, cooldownHours: 0, csrfToken: "c" },
    trackingOptOut: { offered: false, optedOutAt: null, csrfToken: "c" },
  } as unknown as Parameters<typeof renderUserPrivacyBody>[0];

  it("drops the recap sentence and link", () => {
    const html = renderUserPrivacyBody({ ...base, rewindEnabled: false });
    expect(html).not.toContain("/me/rewind");
    expect(html).not.toContain(">Rewind</a>");
    expect(html).toContain("It is a record.");
  });

  it("keeps it while Rewind is on", () => {
    const html = renderUserPrivacyBody({ ...base, rewindEnabled: true });
    expect(html).toContain('<a href="/me/rewind">Rewind</a>');
  });
});

// ---- Overview follows MemberOverviewPage (#1508) ---------------------------

const LIVE = {
  id: "65a000000000000000000002",
  title: "Live quiz",
  when: "2030-01-01 19:00 (UTC)",
  state: "active",
  running: true,
};
const PLANNED = {
  id: "65a000000000000000000001",
  title: "Quiz night",
  when: "2030-01-02 19:00 (UTC)",
  state: "scheduled",
  running: false,
};

describe("overview (#1508)", () => {
  it("opens with a PageHeader holding the title and the greeting", () => {
    const html = overview();
    expect(html).toContain('<header class="kb-pagehead">');
    expect(html).toContain(
      '<h1 class="kb-pagehead__title">My preferences</h1>',
    );
    expect(html).toContain('<p class="kb-pagehead__sub">');
    expect(html).not.toContain('class="subtitle"');
    expect(html.indexOf("kb-pagehead")).toBeLessThan(
      html.indexOf("kb-features"),
    );
  });

  it("shows one FeatureCard per preference with its current value", () => {
    const html = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      preferenceValues: {
        notifications: "2 of 3 on",
        timezone: "Europe/Oslo · 10:59 now",
        voice: "Server default naming · No presets",
        birthday: "14 March",
        privacy: "Tracking on",
      },
    });
    expect(html.match(/class="kb-feature"/g)).toHaveLength(6);
    expect(html).toContain('<p class="kb-feature__value">2 of 3 on</p>');
    expect(html).toContain(
      '<p class="kb-feature__value">Europe/Oslo · 10:59 now</p>',
    );
    expect(html).toContain('<p class="kb-feature__value">14 March</p>');
    expect(html).not.toContain("feature-list");
  });

  it("leaves the value line out when a value is not known, and escapes it", () => {
    const html = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      preferenceValues: { voice: "<b>x</b> · No presets" },
    });
    expect(html.match(/kb-feature__value/g)).toHaveLength(1);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; · No presets");
  });

  it("puts a live hosted event first, with a Live badge and its host panel link", () => {
    const html = overview();
    expect(html).not.toContain("hosting-now");
    const live = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      hostedEvents: [PLANNED, LIVE],
    });
    expect(live).toContain('<span class="kb-badge kb-badge--on">Live</span>');
    expect(live).toContain(`href="/me/events/${LIVE.id}/host"`);
    expect(live.indexOf("hosting-now-h")).toBeGreaterThan(
      live.indexOf("kb-pagehead"),
    );
    expect(live.indexOf("hosting-now-h")).toBeLessThan(
      live.indexOf("kb-features"),
    );
    // The planned event is a count that links to Your events, not a panel.
    expect(live).not.toContain("Quiz night");
    expect(live).toContain(
      '<a href="/me/events">1 event</a> you host is planned.',
    );
    expect(live).not.toContain(" · active");
  });

  it("describes only planned events as one line with a count", () => {
    const html = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      hostedEvents: [PLANNED, { ...PLANNED, id: "65a000000000000000000003" }],
    });
    expect(html).not.toContain("kb-badge");
    expect(html).not.toContain("hosting-now");
    expect(html).toContain(
      '<a href="/me/events">2 events</a> you host are planned.',
    );
  });

  it("shows poll participation as StatTiles, not Rewind stat boxes", () => {
    const html = renderUserIndexBody({
      discordUserId: "u1",
      guildId: "g1",
      isAdmin: false,
      pollParticipation: {
        totalVotes: 3,
        thisYearVotes: 2,
        thisWeekVotes: 1,
        lastVoted: null,
      },
    });
    expect(html).toContain('<div class="kb-tiles">');
    expect(html.match(/class="kb-tile"/g)).toHaveLength(4);
    expect(html).toContain('<div class="kb-tile__value">3</div>');
    expect(html).not.toContain("rw-stat");
    expect(html).not.toContain("rw-grid");
  });

  it("gives the account ids as one help line, not a panel, and says Server", () => {
    const html = overview();
    expect(html).toContain(
      '<p class="kb-help">User <span class="kb-mono">u1</span> · Server <span class="kb-mono">g1</span>. To sign in as someone else, run <span class="kb-mono">/me</span> with that account.</p>',
    );
    expect(html).not.toContain("Account context");
    expect(html).not.toContain("Guild");
    expect(html).not.toContain('class="card"');
  });

  it("spells the product KoolBot", () => {
    expect(overview()).not.toContain("Koolbot");
    expect(overview()).toContain("KoolBot");
  });
});
