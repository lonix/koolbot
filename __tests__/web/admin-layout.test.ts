import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  escapeHtml,
  getDisplayedRemainingMs,
  NAV_ITEMS,
  renderAdminPage,
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
