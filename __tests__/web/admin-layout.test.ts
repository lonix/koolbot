import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  escapeHtml,
  getDisplayedRemainingMs,
  getInactivityWindowMs,
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

  it("hides feature-gated nav items whose feature is disabled", () => {
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
    // Disabled features are gone.
    expect(html).not.toContain('href="/admin/announcements"');
    expect(html).not.toContain('href="/admin/reaction-roles"');
    expect(html).not.toContain('href="/admin/notices"');
    // Enabled features stay.
    expect(html).toContain('href="/admin/polls"');
    expect(html).toContain('href="/admin/voice-channels"');
    // Ungated items are always present.
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
