import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  escapeHtml,
  getDisplayedRemainingMs,
  getInactivityWindowMs,
  NAV_ITEMS,
  renderAdminPage,
  resolveNavFeatureStatus,
  setAdminUpdateBadgeProvider,
} from "../../src/web/admin-layout.js";
import { getBotVersion } from "../../src/utils/version.js";

describe("admin-layout escapeHtml", () => {
  it("returns empty string for null/undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<script>"x'&y"</script>`)).toBe(
      "&lt;script&gt;&quot;x&#39;&amp;y&quot;&lt;/script&gt;",
    );
  });

  it("stringifies non-strings before escaping", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(true)).toBe("true");
  });
});

describe("admin-layout NAV_ITEMS", () => {
  it("includes every page promised by issue #381", () => {
    const labels = NAV_ITEMS.map((n) => n.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Dashboard",
        "All settings",
        "Command permissions",
        "Announcements",
        "Polls",
        "Reaction roles",
        "Notices",
        "Voice channels",
        "Database",
        "Environment",
      ]),
    );
  });
});

describe("renderAdminPage", () => {
  it("renders the session-expires banner with the supplied countdown ms", () => {
    const html = renderAdminPage({
      title: "Test",
      active: "/admin/",
      body: "<p>hi</p>",
      csrfToken: "csrftoken",
      remainingMs: 1234567,
    });
    expect(html).toContain('id="session-countdown"');
    expect(html).toContain('data-remaining-ms="1234567"');
    expect(html).toContain('action="/admin/finish"');
    expect(html).toContain('value="csrftoken"');
    expect(html).toContain("<p>hi</p>");
  });

  it("emits data-inactivity-ms so the banner script knows the sliding window", () => {
    const saved = process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "20";
    try {
      const html = renderAdminPage({
        title: "Test",
        active: "/admin/",
        body: "",
        csrfToken: "",
        remainingMs: 0,
      });
      expect(html).toContain(`data-inactivity-ms="${20 * 60 * 1000}"`);
    } finally {
      if (saved === undefined) {
        delete process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
      } else {
        process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = saved;
      }
    }
  });

  it("ships a banner script that polls /admin/session/ping and handles activity", () => {
    const html = renderAdminPage({
      title: "Test",
      active: "/admin/",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    // The polling and activity-listener wiring from #435.
    expect(html).toContain("/admin/session/ping");
    expect(html).toContain("mousemove");
    expect(html).toContain("keydown");
  });

  it("ships the AJAX section-save script that posts via fetch (issue #555)", () => {
    const html = renderAdminPage({
      title: "Settings",
      active: "/admin/settings",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    // Progressive enhancement: the per-section Save submits via fetch() so the
    // page no longer reloads and jumps to the top. The script targets the
    // save-section form, advertises a JSON response, and renders an inline
    // flash instead of redirecting.
    expect(html).toContain('form[action="/admin/settings/save-section"]');
    expect(html).toContain("'X-Requested-With':'fetch'");
    expect(html).toContain("section-flash");
    // Reset buttons (formaction) must still submit natively.
    expect(html).toContain("getAttribute('formaction')");
    // The body must be urlencoded, not raw multipart FormData: the router
    // only mounts express.urlencoded, so a multipart body arrives empty and
    // `_csrf` is lost, failing requireCsrf with "CSRF token missing"
    // (issue #628). Wrapping FormData in URLSearchParams keeps it urlencoded.
    expect(html).toContain("URLSearchParams(new FormData(form))");
    expect(html).not.toContain("body:new FormData(form)");
  });

  it("follows a same-origin reload URL from a feature-card save (#970)", () => {
    const html = renderAdminPage({
      title: "Polls",
      active: "/admin/polls",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    // An enable-flag flip returns `reload`; the script navigates only to an
    // /admin/ path so a tampered reply can't send the browser off-site.
    expect(html).toContain("r.json.reload");
    expect(html).toContain(
      "rl.indexOf('/admin/')===0&&rl.indexOf('//')<0){window.location.assign(rl)",
    );
  });

  it("keeps a hidden .btn hidden despite the .btn display rule", () => {
    const html = renderAdminPage({
      title: "Leaderboard Roles",
      active: "/admin/leaderboard-roles",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    // `.btn{display:inline-block}` beats the UA `[hidden]` rule, so JS-only
    // controls such as the tier editor's Add/Remove need this override.
    expect(html).toContain(".btn[hidden]{display:none}");
  });

  it("marks and focuses the fields a save rejected (issue #854)", () => {
    const html = renderAdminPage({
      title: "Settings",
      active: "/admin/settings",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    // The AJAX save reads the server's `invalidKeys` and stamps `aria-invalid`
    // on those controls, pointing their description at the section flash so
    // the field carries the actual reason.
    expect(html).toContain("data.invalidKeys");
    expect(html).toContain("document.getElementById('set-'+keys[i])");
    expect(html).toContain("el.setAttribute('aria-invalid','true')");
    // The flash node is named so `aria-describedby` can reference it.
    expect(html).toContain("n.id='section-flash-'+(++seq)");
    // The pre-existing description is stashed and restored, so clearing a
    // rejection can't leave `aria-describedby` pointing at a removed note.
    expect(html).toContain("data-describedby-base");
    // A full page load (the no-JS save path) focuses the first marked field.
    expect(html).toContain("document.querySelector('[aria-invalid=\"true\"]')");
    // A cron row's target is the group <div>, which isn't focusable on its
    // own, so focusInvalid gives a non-native target a tagged `tabindex` and
    // clearInvalid takes back exactly what it added.
    expect(html).toContain("el.setAttribute('tabindex','-1')");
    expect(html).toContain(
      "!/^(a|button|input|select|textarea)$/i.test(el.tagName)",
    );
    expect(html).toContain("form.querySelectorAll('[data-a11y-tabindex]')");
    // Styling: an invalid control is outlined, and off-screen labels stay in
    // the accessibility tree.
    expect(html).toContain(
      '[aria-invalid="true"]{outline:2px solid var(--danger)',
    );
    expect(html).toContain(".visually-hidden{position:absolute");
  });

  it("escapes the title", () => {
    const html = renderAdminPage({
      title: "<bad>",
      active: "/admin/",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    expect(html).toContain("&lt;bad&gt;");
    expect(html).not.toContain("<title><bad>");
  });

  it("ships CSS that bounds long settings values within their cell (issue #489)", () => {
    const html = renderAdminPage({
      title: "Settings",
      active: "/admin/settings",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    // Editable controls are capped to the cell width so long channel/role
    // lists or custom strings don't push the table past the page edge.
    expect(html).toContain(
      "td.settings-value input[type=text],td.settings-value select{width:100%;box-sizing:border-box}",
    );
    // The default-value cell wraps long content instead of forcing a wide row.
    expect(html).toContain(
      "td.settings-default{overflow-wrap:anywhere;word-break:break-word}",
    );
  });

  const render = (): string =>
    renderAdminPage({
      title: "Test",
      active: "/admin/settings",
      body: "<p>hi</p>",
      csrfToken: "csrf",
      remainingMs: 60_000,
    });

  it("gives keyboard users a visible focus ring, a skip link and aria-current (#855)", () => {
    const html = render();
    // One :focus-visible ring for every interactive element, plus mirrored
    // hover surfaces for the sidebar and buttons.
    expect(html).toContain(
      "a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}",
    );
    // The ring rule is declared after the aria-invalid outline so it wins on
    // focus (same specificity, later wins).
    expect(html.indexOf('[aria-invalid="true"]{outline')).toBeLessThan(
      html.indexOf("a:focus-visible,button:focus-visible"),
    );
    // Skip link is the first focusable thing on the page and targets <main>.
    expect(html).toMatch(
      /<body><a class="skip-link" href="#main">Skip to content<\/a>/,
    );
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(html).toContain(".skip-link:focus{left:0");
    // aria-current marks the active page, not just a CSS class.
    expect(html).toContain('<a href="/admin/settings" aria-current="page">');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("reflows at narrow widths instead of forcing horizontal page scroll (#855)", () => {
    const html = render();
    expect(html).toContain(
      "@media (max-width:760px){.shell{flex-direction:column}",
    );
    // Wide tables scroll inside their container, not the page.
    expect(html).toContain(
      "main{flex:1;padding:1.5rem 2rem;max-width:1100px;min-width:0;overflow-x:auto}",
    );
    expect(html).toContain("margin:0 0 1rem;overflow-x:auto}");
  });

  it("keeps the sticky save bar's ancestors from being scroll containers", () => {
    const css = render();
    const rule = (sel: string): string => {
      const i = css.indexOf(`${sel}{`);
      expect(i).toBeGreaterThan(-1);
      return css.slice(i, css.indexOf("}", i));
    };
    // `overflow-x:auto|scroll|hidden` on an ancestor makes it the sticky
    // container, so the bar would stick inside the card instead of the viewport.
    // Without a save bar `main` keeps scrolling; with one it only clips.
    expect(rule("main")).toContain("overflow-x:auto");
    expect(rule("main.has-savebar")).toContain("overflow-x:clip");
    expect(rule("main.has-savebar")).not.toMatch(
      /overflow(-x|-y)?:(auto|scroll|hidden)/,
    );
    // A long unbroken value scrolls in its own block.
    expect(rule("main pre")).toContain("overflow-x:auto");
    expect(rule(".card.card--savebar")).toContain("overflow-x:clip");
    expect(rule(".card.card--savebar")).not.toMatch(
      /overflow(-x|-y)?:(auto|scroll|hidden)/,
    );
    // The rows scroll sideways instead, so wide pickers stay reachable.
    expect(rule(".kb-settings")).toContain("overflow-x:auto");
  });

  it("marks <main> as has-savebar exactly when the body renders a save bar", () => {
    const page = (body: string): string =>
      renderAdminPage({
        title: "T",
        active: "/admin/settings",
        body,
        csrfToken: "c",
        remainingMs: 1,
      });
    const mainTag = (html: string): string =>
      html.match(/<main[^>]*>/)?.[0] ?? "";
    expect(
      mainTag(page('<form><div class="kb-savebar"></div></form>')),
    ).toContain('class="has-savebar"');
    expect(mainTag(page("<p>no bar</p>"))).not.toContain("has-savebar");
    // Escaped user text cannot fake the marker.
    expect(
      mainTag(page("&quot;kb-savebar&quot; class=&quot;kb-savebar&quot;")),
    ).not.toContain("has-savebar");
  });

  it("uses colours that clear the WCAG contrast floors (#855)", () => {
    const html = render();
    // Form-control borders: the --border hairline was 1.58:1 against the field.
    expect(html).toContain(
      "form.stack textarea,form.stack select{background:var(--bg);color:var(--text);border:1px solid var(--control);",
    );
    expect(html).not.toContain(
      "border:1px solid var(--border);border-radius:6px;padding:.4rem .55rem",
    );
    // Finish button: white on #ef4444 was 3.76:1. It is the kb-btn--danger of the
    // shared top bar now, whose --danger pair a11y-contrast.test.ts gates.
    expect(html).toContain(
      '<button type="submit" class="kb-btn kb-btn--danger kb-btn--sm">Finish</button>',
    );
    expect(html).not.toContain("#ef4444");
    // Small muted text at 12px: a darker grey and --control were < 4.5:1.
    expect(html).not.toContain("#6b7280");
    expect(html).not.toContain("var(--control);flex-shrink");
    expect(html).toContain(
      ".field-row .help{font-size:.75rem;color:var(--muted);",
    );
  });

  it("announces the AJAX save result through a live region and focuses a post-redirect flash (#855)", () => {
    const html = render();
    expect(html).toContain(
      "n.className='notice section-flash';n.setAttribute('role','status');n.setAttribute('aria-live','polite');",
    );
    // With nothing aria-invalid, the on-load script focuses the flash.
    expect(html).toContain(
      "var inv=document.querySelector('[aria-invalid=\"true\"]');if(inv){focusInvalid(inv);return}var f=document.querySelector('.notice[data-flash]');if(f){try{f.focus()}catch(e){}}",
    );
    expect(html).toContain("#main:focus-visible{outline:none}");
  });

  it("marks the active nav item", () => {
    const html = renderAdminPage({
      title: "Settings",
      active: "/admin/settings",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    expect(html).toContain('<a href="/admin/settings" aria-current="page">');
  });

  it("shows every nav item when navFeatureStatus is omitted", () => {
    const html = renderAdminPage({
      title: "Dashboard",
      active: "/admin/",
      body: "",
      csrfToken: "",
      remainingMs: 0,
    });
    for (const item of NAV_ITEMS) {
      expect(html).toContain(`href="${item.href}"`);
    }
  });

  it("shows feature-gated nav items even when disabled, marked off (#610)", () => {
    const html = renderAdminPage({
      title: "Dashboard",
      active: "/admin/",
      body: "",
      csrfToken: "",
      remainingMs: 0,
      navFeatureStatus: {
        "announcements.enabled": false,
        "polls.enabled": true,
        "reactionroles.enabled": false,
        "notices.enabled": false,
        "voicechannels.enabled": true,
      },
    });
    // Disabled features stay advertised so the page is discoverable...
    expect(html).toContain('href="/admin/announcements"');
    expect(html).toContain('href="/admin/reaction-roles"');
    expect(html).toContain('href="/admin/notices"');
    // ...but greyed and tagged "off".
    expect(html).toContain('href="/admin/announcements" class="is-off"');
    expect(html).toContain('href="/admin/reaction-roles" class="is-off"');
    expect(html).toContain('href="/admin/notices" class="is-off"');
    expect(html).toContain(
      '<span class="kb-badge kb-badge--off kb-sidenav__end">off</span>',
    );
    // Enabled features render as plain links (no disabled marker).
    expect(html).toContain('href="/admin/polls"');
    expect(html).not.toContain('href="/admin/polls" class="is-off"');
    expect(html).toContain('href="/admin/voice-channels"');
    expect(html).not.toContain('href="/admin/voice-channels" class="is-off"');
    // Ungated items are always present and never marked disabled.
    expect(html).toContain('href="/admin/settings"');
    expect(html).toContain('href="/admin/database"');
    expect(html).toContain('href="/admin/bootstrap"');
    expect(html).not.toContain('href="/admin/settings" class="is-off"');
  });

  it("keeps an item visible when its featureKey is missing from the status map", () => {
    // A wiring gap (featureKey absent from the map) must not blank the
    // item — fail open, not closed.
    const html = renderAdminPage({
      title: "Dashboard",
      active: "/admin/",
      body: "",
      csrfToken: "",
      remainingMs: 0,
      navFeatureStatus: {},
    });
    expect(html).toContain('href="/admin/notices"');
  });
});

describe("renderAdminPage sidebar grouped by task (#613, #1296)", () => {
  // Every feature switched on, unless a test says otherwise.
  const featureKeys = NAV_ITEMS.flatMap((n) =>
    n.featureKey ? [n.featureKey] : [],
  );
  const status = (off: string[] = []): Record<string, boolean> =>
    Object.fromEntries(featureKeys.map((k) => [k, !off.includes(k)]));
  const render = (
    navFeatureStatus?: Record<string, boolean>,
    active = "/admin/",
  ): string =>
    renderAdminPage({
      title: "Dashboard",
      active,
      body: "",
      csrfToken: "",
      remainingMs: 0,
      navFeatureStatus,
    });
  /** The side nav only: the top bar shares `/admin/` and other links. */
  const navOf = (html: string): string =>
    html.slice(html.indexOf('<nav class="kb-sidenav"'), html.indexOf("</nav>"));
  const hrefsIn = (html: string): string[] =>
    [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  const FOLD = /<details data-nav-off( open)?>[\s\S]*?<\/details>/;

  it("renders the four headed groups in the fixed order, none of the old ones", () => {
    const nav = navOf(render());
    const headings = [
      ...nav.matchAll(/kb-sidenav__heading" id="[^"]+">([^<]+)</g),
    ].map((m) => m[1]);
    expect(headings).toEqual(["Features", "Access", "Server setup", "Bot"]);
    for (const old of ["Info", "Settings"]) {
      expect(nav).not.toContain(`>${old}<`);
    }
  });

  it("puts Dashboard first with no heading, and All settings last, pinned", () => {
    const nav = navOf(render());
    const hrefs = hrefsIn(nav);
    expect(hrefs[0]).toBe("/admin/");
    expect(hrefs[hrefs.length - 1]).toBe("/admin/settings");
    expect(nav).toContain(
      '<div class="kb-sidenav__group kb-sidenav__pinned"><ul><li><a href="/admin/settings"',
    );
    // Dashboard precedes the first heading.
    expect(nav.indexOf('href="/admin/"')).toBeLessThan(
      nav.indexOf("kb-sidenav__heading"),
    );
  });

  it("lists each page under the group the issue names, in its order", () => {
    const nav = navOf(render(status()));
    const sectionOf = (heading: string): string => {
      const start = nav.indexOf(`">${heading}</p>`);
      const rest = nav.slice(start + 1);
      const next = rest.indexOf("kb-sidenav__heading");
      const pinned = rest.indexOf("kb-sidenav__pinned");
      const ends = [next, pinned].filter((i) => i > -1);
      return rest.slice(0, ends.length ? Math.min(...ends) : undefined);
    };
    expect(hrefsIn(sectionOf("Access"))).toEqual([
      "/admin/permissions",
      "/admin/role-groups",
      "/admin/bot-permissions",
    ]);
    expect(hrefsIn(sectionOf("Server setup"))).toEqual([
      "/admin/wizard",
      "/admin/adopt",
      "/admin/adopt/claims",
      "/admin/channels",
      "/admin/adopt/history",
    ]);
    expect(hrefsIn(sectionOf("Bot"))).toEqual([
      "/admin/bot-status",
      "/admin/database",
      "/admin/bootstrap",
      "/admin/audit/commands",
      "/admin/metrics",
    ]);
  });

  it("links Event presets next to Events and marks only the page it is on (#1298)", () => {
    const on = navOf(render(status(), "/admin/events/presets"));
    expect(on).toContain(
      '<a href="/admin/events/presets" aria-current="page">Event presets</a>',
    );
    expect(on).toContain('<a href="/admin/events">Events</a>');
    expect(on.match(/aria-current="page"/g)).toHaveLength(1);
    // Gated on Events like the Events page: greyed in the fold while it is off.
    const off = navOf(render(status(["events.enabled"])));
    expect(off).toContain('<a href="/admin/events/presets" class="is-off"');
  });

  it("labels the renamed pages and keeps their routes", () => {
    const nav = navOf(render());
    const labelled: Array<[string, string]> = [
      ["/admin/permissions", "Command permissions"],
      ["/admin/bot-status", "Presence"],
      ["/admin/bootstrap", "Environment"],
      ["/admin/adopt/history", "Adoption history"],
      ["/admin/settings", "All settings"],
      ["/admin/bot-permissions", "Bot permissions"],
    ];
    for (const [href, label] of labelled) {
      expect(nav).toContain(`<a href="${href}">${label}</a>`);
    }
  });

  it("lists the switched-on features A to Z, Moderation among them", () => {
    const nav = navOf(render(status()));
    const features = hrefsIn(
      nav.slice(nav.indexOf('">Features</p>'), nav.indexOf('">Access</p>')),
    );
    const labels = features.map(
      (h) => NAV_ITEMS.find((n) => n.href === h)?.label ?? "",
    );
    expect(labels).toContain("Moderation");
    expect(labels).toEqual(
      [...labels].sort((a, b) => a.localeCompare(b, "en")),
    );
    expect(labels).toHaveLength(
      NAV_ITEMS.filter((n) => n.group === "Features").length,
    );
    // Nothing is folded away while everything is on.
    expect(nav).not.toContain("<details");
  });

  it("sorts the features itself: declaration order does not decide the list", () => {
    const saved = [...NAV_ITEMS];
    NAV_ITEMS.reverse();
    try {
      const nav = navOf(
        render(status(["polls.enabled", "events.enabled", "quotes.enabled"])),
      );
      const fold = FOLD.exec(nav)?.[0] ?? "";
      const labelsOf = (html: string): string[] =>
        hrefsIn(html).map((h) => saved.find((n) => n.href === h)?.label ?? "");
      const inFold = labelsOf(fold);
      const outside = labelsOf(
        nav.slice(nav.indexOf('">Features</p>'), nav.indexOf("<details")),
      );
      expect(inFold).toEqual(["Event presets", "Events", "Polls", "Quotes"]);
      expect(outside.length).toBeGreaterThan(3);
      expect(outside).toEqual(
        [...outside].sort((a, b) => a.localeCompare(b, "en")),
      );
    } finally {
      NAV_ITEMS.splice(0, NAV_ITEMS.length, ...saved);
    }
  });

  it("folds the switched-off features into 'N turned off', A to Z, after the switched-on ones", () => {
    const html = render(
      status([
        "voicechannels.enabled",
        "announcements.enabled",
        "moderation.enabled",
      ]),
    );
    const nav = navOf(html);
    const fold = FOLD.exec(nav);
    expect(fold).not.toBeNull();
    const [folded, open] = fold as RegExpExecArray;
    expect(open).toBeUndefined();
    expect(folded).toContain("</svg>3 turned off</summary>");
    expect(hrefsIn(folded)).toEqual([
      "/admin/announcements",
      "/admin/moderation",
      "/admin/voice-channels",
    ]);
    for (const href of hrefsIn(folded)) {
      expect(folded).toContain(`<a href="${href}" class="is-off"`);
    }
    // The switched-on features sit outside the fold and are not marked off.
    const outside = nav.replace(folded, "");
    expect(outside).toContain('<a href="/admin/polls">');
    expect(outside).not.toContain("is-off");
    expect(outside).not.toContain('href="/admin/moderation"');
    // The fold comes after the last switched-on feature, before Access.
    expect(nav.indexOf("<details")).toBeGreaterThan(
      nav.indexOf('href="/admin/digest"'),
    );
    expect(nav.indexOf("<details")).toBeLessThan(nav.indexOf('">Access</p>'));
  });

  it("counts one turned-off feature, and still renders the Features heading when all are off (#610)", () => {
    const one = navOf(render(status(["polls.enabled"])));
    expect(one).toContain("</svg>1 turned off</summary>");
    const all = navOf(render(status(featureKeys)));
    expect(all).toContain('">Features</p>');
    expect(all).toContain(`</svg>${featureKeys.length} turned off</summary>`);
    // Every feature is still linked, so each page stays reachable and enable-able.
    for (const item of NAV_ITEMS.filter((n) => n.featureKey)) {
      expect(all).toContain(`href="${item.href}"`);
    }
  });

  it("leaves the fold closed by default and opens it when the current page is inside it", () => {
    const off = status(["polls.enabled"]);
    expect(
      FOLD.exec(navOf(render(off, "/admin/notices")))?.[1],
    ).toBeUndefined();
    const onPage = render(off, "/admin/polls");
    expect(FOLD.exec(navOf(onPage))?.[1]).toBe(" open");
    expect(onPage).toContain(
      '<a href="/admin/polls" class="is-off" aria-current="page"',
    );
  });

  it("remembers the fold per browser, in try/catch, and never writes a forced-open state", () => {
    const html = render(status(["polls.enabled"]));
    expect(html).toContain("details[data-nav-off]");
    expect(html).toContain("localStorage.getItem(k)==='1'");
    expect(html).toContain("localStorage.setItem(k,d.open?'0':'1')");
    // Both storage touches are guarded, and the write happens on click (before
    // `open` flips), not on `toggle`, which also fires for a server-set `open`.
    expect(html).toMatch(
      /try\{if\(localStorage\.getItem\(k\)==='1'\)d\.open=true\}catch\(e\)\{\}/,
    );
    expect(html).toMatch(
      /addEventListener\('click',function\(\)\{try\{localStorage\.setItem/,
    );
    expect(html).not.toContain("addEventListener('toggle'");
  });

  it("keeps the Bot permissions issue-count badge in Access (#1217)", async () => {
    const { setPermissionIssueCount, resetPermissionIssueCount } =
      await import("../../src/services/bot-permission-status.js");
    setPermissionIssueCount("guild-1", 3);
    try {
      expect(navOf(render())).toContain(
        '<a href="/admin/bot-permissions">Bot permissions<span class="kb-badge kb-badge--warn kb-badge--count kb-sidenav__end" title="Missing permissions affect enabled features">3</span></a>',
      );
    } finally {
      resetPermissionIssueCount();
    }
    expect(navOf(render())).not.toContain("kb-badge--warn");
  });

  it("renders every nav entry exactly once, whatever the feature status", () => {
    for (const nav of [
      navOf(render()),
      navOf(render(status(featureKeys))),
      navOf(render(status(["polls.enabled"]))),
    ]) {
      const hrefs = hrefsIn(nav);
      expect([...hrefs].sort()).toEqual(NAV_ITEMS.map((n) => n.href).sort());
    }
  });

  it("uses design-system classes only: no legacy nav.side styles", () => {
    const html = render();
    expect(html).not.toContain("nav.side");
    expect(html).not.toContain("nav-group");
    expect(html).not.toContain("nav-disabled");
  });
});

describe("resolveNavFeatureStatus", () => {
  it("resolves the enabled-state of every feature-gated nav item", async () => {
    // Two pages may share a key (Events and Event presets); it is read once.
    const gatedKeys = [
      ...new Set(
        NAV_ITEMS.flatMap((n) => (n.featureKey ? [n.featureKey] : [])),
      ),
    ];
    const seen: string[] = [];
    const status = await resolveNavFeatureStatus(async (key) => {
      seen.push(key);
      return key === "polls.enabled";
    });
    // Every gated key was queried, and only gated keys were queried.
    expect(seen.sort()).toEqual([...gatedKeys].sort());
    expect(status["polls.enabled"]).toBe(true);
    expect(status["notices.enabled"]).toBe(false);
  });
});

describe("getDisplayedRemainingMs", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
    delete process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
    } else {
      process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = saved;
    }
  });

  it("defaults to 30 minutes when env var is unset", () => {
    expect(getDisplayedRemainingMs()).toBe(30 * 60 * 1000);
  });

  it("uses the env var when valid", () => {
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "5";
    expect(getDisplayedRemainingMs()).toBe(5 * 60 * 1000);
  });

  it("falls back to default for invalid values", () => {
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "abc";
    expect(getDisplayedRemainingMs()).toBe(30 * 60 * 1000);
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "0";
    expect(getDisplayedRemainingMs()).toBe(30 * 60 * 1000);
  });

  it("honours the TTL hard cap when it ends before the inactivity window", () => {
    // Inactivity window = 30 min, but the session has only 5 min left.
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const remaining = getDisplayedRemainingMs({ expiresAt });
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(remaining).toBeGreaterThan(4 * 60 * 1000);
  });

  it("uses the inactivity window when the TTL cap is further out", () => {
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "10";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
    expect(getDisplayedRemainingMs({ expiresAt })).toBe(10 * 60 * 1000);
  });

  it("returns 0 when the hard cap has already passed", () => {
    const expiresAt = new Date(Date.now() - 1000);
    expect(getDisplayedRemainingMs({ expiresAt })).toBe(0);
  });
});

describe("getInactivityWindowMs", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
    delete process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
    } else {
      process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = saved;
    }
  });

  it("defaults to 30 minutes when unset", () => {
    expect(getInactivityWindowMs()).toBe(30 * 60 * 1000);
  });

  it("reads the env var when set to a positive number", () => {
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "5";
    expect(getInactivityWindowMs()).toBe(5 * 60 * 1000);
  });

  it("falls back to the default on garbage values", () => {
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "nope";
    expect(getInactivityWindowMs()).toBe(30 * 60 * 1000);
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "-5";
    expect(getInactivityWindowMs()).toBe(30 * 60 * 1000);
  });
});

describe("admin-layout version banner (#1029)", () => {
  const render = (): string =>
    renderAdminPage({
      title: "T",
      active: "/admin/",
      body: "",
      csrfToken: "c",
      remainingMs: 1000,
    });

  afterEach(() => {
    setAdminUpdateBadgeProvider(null);
  });

  it("shows the running version on every page", () => {
    const version = getBotVersion();
    const html = render();
    expect(html).toContain('title="Running version"');
    expect(html).toContain(version === "unknown" ? version : `v${version}`);
    expect(html).not.toContain("Update available");
  });

  it("adds a badge linking to the dashboard card when behind", () => {
    setAdminUpdateBadgeProvider(() => ({ latest: "v9.0.0", kind: "major" }));
    const html = render();
    expect(html).toContain('href="/admin/#version"');
    expect(html).toContain("Update available: v9.0.0 (major)");
  });

  it("shows no badge when the provider has nothing, or throws", () => {
    setAdminUpdateBadgeProvider(() => null);
    expect(render()).not.toContain("Update available");
    setAdminUpdateBadgeProvider(() => {
      throw new Error("boom");
    });
    expect(render()).not.toContain("Update available");
  });
});
