import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  escapeHtml,
  getDisplayedRemainingMs,
  getInactivityWindowMs,
  NAV_GROUP_ORDER,
  NAV_ITEMS,
  renderAdminPage,
  resolveNavFeatureStatus,
} from "../../src/web/admin-layout.js";

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
        "Settings",
        "Permissions",
        "Announcements",
        "Polls",
        "Reaction Roles",
        "Notices",
        "Voice Channels",
        "Database",
        "Bootstrap",
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
    expect(html).toContain('[aria-invalid="true"]{outline:2px solid #dc2626');
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
      "a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}",
    );
    expect(html).toContain("nav.side a:focus-visible{background:#1f2937");
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
    expect(html).toContain(
      'href="/admin/settings" class="active" aria-current="page"',
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("reflows at narrow widths instead of forcing horizontal page scroll (#855)", () => {
    const html = render();
    expect(html).toContain(
      "@media (max-width:760px){.shell{flex-direction:column}",
    );
    expect(html).toContain("nav.side{width:auto;border-right:0;");
    // Wide tables scroll inside their container, not the page.
    expect(html).toContain(
      "main{flex:1;padding:1.5rem 2rem;max-width:1100px;min-width:0;overflow-x:auto}",
    );
    expect(html).toContain("margin:0 0 1rem;overflow-x:auto}");
  });

  it("uses colours that clear the WCAG contrast floors (#855)", () => {
    const html = render();
    // Form-control borders: #2d3748 was 1.58:1 against the field.
    expect(html).toContain(
      "form.stack textarea,form.stack select{background:#0f1115;color:#e4e6eb;border:1px solid #64748b;",
    );
    expect(html).not.toContain(
      "border:1px solid #2d3748;border-radius:6px;padding:.4rem .55rem",
    );
    // Finish button: white on #ef4444 was 3.76:1.
    expect(html).toContain(".banner button{background:#dc2626;");
    expect(html).not.toContain("#ef4444");
    // Small muted text at 12px: #6b7280 / #64748b were < 4.5:1.
    expect(html).not.toContain("#6b7280");
    expect(html).not.toContain("#64748b;flex-shrink");
    expect(html).toContain(".field-row .help{font-size:.75rem;color:#94a3b8;");
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
    expect(html).toContain('href="/admin/settings" class="active"');
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
    expect(html).toContain('href="/admin/announcements" class="nav-disabled"');
    expect(html).toContain('href="/admin/reaction-roles" class="nav-disabled"');
    expect(html).toContain('href="/admin/notices" class="nav-disabled"');
    expect(html).toContain('<span class="nav-badge">off</span>');
    // Enabled features render as plain links (no disabled marker).
    expect(html).toContain('href="/admin/polls"');
    expect(html).not.toContain('href="/admin/polls" class="nav-disabled"');
    expect(html).toContain('href="/admin/voice-channels"');
    expect(html).not.toContain(
      'href="/admin/voice-channels" class="nav-disabled"',
    );
    // Ungated items are always present and never marked disabled.
    expect(html).toContain('href="/admin/settings"');
    expect(html).toContain('href="/admin/database"');
    expect(html).toContain('href="/admin/bootstrap"');
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

describe("renderAdminPage grouped sidebar (#613)", () => {
  const render = (navFeatureStatus?: Record<string, boolean>): string =>
    renderAdminPage({
      title: "Dashboard",
      active: "/admin/",
      body: "",
      csrfToken: "",
      remainingMs: 0,
      navFeatureStatus,
    });

  it("renders every group heading in the fixed order", () => {
    const html = render();
    const positions = NAV_GROUP_ORDER.map((g) =>
      html.indexOf(`nav-group-heading">${g}<`),
    );
    // All present...
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    // ...and in ascending (fixed) order.
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("groups each nav item under its declared group heading", () => {
    const html = render();
    // Heading order maps to the fixed group order; an item must appear after
    // its own group's heading and before the next group's heading.
    const headingPos = (g: string): number =>
      html.indexOf(`nav-group-heading">${g}<`);
    for (const item of NAV_ITEMS) {
      const groupIdx = NAV_GROUP_ORDER.indexOf(item.group);
      const start = headingPos(item.group);
      const nextGroup = NAV_GROUP_ORDER[groupIdx + 1];
      const end = nextGroup === undefined ? html.length : headingPos(nextGroup);
      const itemPos = html.indexOf(`href="${item.href}"`);
      expect(itemPos).toBeGreaterThan(start);
      expect(itemPos).toBeLessThan(end);
    }
  });

  it("keeps the Features group with items greyed when all are disabled (#610)", () => {
    // Every Features-group item is feature-gated; turn them all off.
    const html = render({
      "announcements.enabled": false,
      "polls.enabled": false,
      "reactionroles.enabled": false,
      "notices.enabled": false,
      "voicechannels.enabled": false,
    });
    // The Features group stays visible — every item is shown, just greyed —
    // so a disabled feature's page is still reachable from the sidebar.
    expect(html).toContain('nav-group-heading">Features<');
    expect(html).toContain('href="/admin/polls" class="nav-disabled"');
    expect(html).toContain('href="/admin/announcements" class="nav-disabled"');
    // The always-present groups remain.
    expect(html).toContain('nav-group-heading">Info<');
    expect(html).toContain('nav-group-heading">Settings<');
  });

  it("renders every Features item, greying only the disabled ones (#610)", () => {
    const html = render({
      "announcements.enabled": false,
      "polls.enabled": true,
      "reactionroles.enabled": false,
      "notices.enabled": false,
      "voicechannels.enabled": false,
    });
    expect(html).toContain('nav-group-heading">Features<');
    // Enabled item: plain link.
    expect(html).toContain('href="/admin/polls"');
    expect(html).not.toContain('href="/admin/polls" class="nav-disabled"');
    // Disabled item: still present, greyed.
    expect(html).toContain('href="/admin/announcements" class="nav-disabled"');
  });

  it("sorts enabled Features nav items above disabled ones, stable within the group (#706)", () => {
    // reactionroles + voicechannels on; announcements + polls + notices off.
    const html = render({
      "announcements.enabled": false,
      "polls.enabled": false,
      "reactionroles.enabled": true,
      "notices.enabled": false,
      "voicechannels.enabled": true,
      "digest.enabled": false,
      "voicetracking.enabled": false,
    });
    // Enabled items sink no lower than any disabled item. Enabled hrefs
    // (reaction-roles, voice-channels) and disabled hrefs (announcements,
    // polls, notices, digest, analytics) partition cleanly.
    const pos = (href: string): number => html.indexOf(`href="${href}"`);
    const enabled = ["/admin/reaction-roles", "/admin/voice-channels"].map(pos);
    const disabled = [
      "/admin/announcements",
      "/admin/polls",
      "/admin/notices",
      "/admin/digest",
      "/admin/analytics",
    ].map(pos);
    for (const p of [...enabled, ...disabled]) expect(p).toBeGreaterThan(-1);
    expect(Math.max(...enabled)).toBeLessThan(Math.min(...disabled));
    // Enabled items preserve their fixed NAV_ITEMS order (reaction-roles
    // precedes voice-channels), confirming the stable secondary sort.
    expect(pos("/admin/reaction-roles")).toBeLessThan(
      pos("/admin/voice-channels"),
    );
  });

  it("ships muted CSS for the group heading consistent with the sidebar", () => {
    expect(render()).toContain("nav.side .nav-group-heading{");
  });
});

describe("resolveNavFeatureStatus", () => {
  it("resolves the enabled-state of every feature-gated nav item", async () => {
    const gatedKeys = NAV_ITEMS.flatMap((n) =>
      n.featureKey ? [n.featureKey] : [],
    );
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
