/**
 * The Dashboard page (#1322): state first, Needs you only when there is
 * something, an unreadable source never drawn as a zero, no switches, escaping.
 */
import { describe, it, expect } from "@jest/globals";
import { renderDashboardBody } from "../../src/web/dashboard-view.js";
import type { DashboardData } from "../../src/web/dashboard-data.js";
import {
  UPDATE_AVAILABLE,
  busyDashboard,
  calmDashboard,
} from "./dashboard-fixtures.js";

const page = (
  data: DashboardData,
  extra: { version?: typeof UPDATE_AVAILABLE } = {},
): string =>
  renderDashboardBody({
    data,
    csrfToken: "tok",
    flashHtml: "",
    ...extra,
  });

describe("DashboardPage", () => {
  it("opens with four tiles that each link to the page where you act", () => {
    const html = page(calmDashboard(), { version: UPDATE_AVAILABLE });
    const tiles = html.slice(
      html.indexOf('<div class="kb-tiles">'),
      html.indexOf('<div class="kb-cols">'),
    );
    expect(tiles.match(/<a class="kb-tile/g)).toHaveLength(4);
    for (const href of [
      "#version",
      "/admin/adopt",
      "/admin/database",
      "/admin/bot-permissions",
    ]) {
      expect(tiles).toContain(`href="${href}"`);
    }
    expect(tiles).toContain("42 <small>members</small>");
    expect(tiles).toContain("3 in voice now");
    expect(tiles).toContain("update available");
  });

  it("hides Needs you when nothing needs the admin", () => {
    const html = page(calmDashboard());
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("kb-tile--warn");
    expect(html).toContain("0 <small>issues</small>");
    expect(html).toContain(
      "Everything the switched-on features need is in place.",
    );
  });

  it("lists one row per problem with a button to the page that fixes it, and warns on the tile", () => {
    const html = page(busyDashboard());
    expect(html).toContain('id="p-needs"');
    expect(html.match(/<li><svg/g)).toHaveLength(3);
    expect(html).toContain(
      "Bot lacks Manage Nicknames in the category &quot;Events&quot;",
    );
    expect(html).toContain(
      '<a class="kb-btn kb-btn--sm" href="/admin/bot-permissions">Open Bot permissions</a>',
    );
    expect(html).toContain(
      '<a class="kb-btn kb-btn--sm" href="/admin/adopt">Open Server scan</a>',
    );
    expect(html).toContain('class="kb-tile kb-tile--warn"');
    expect(html).toContain("2 <small>issues</small>");
    expect(html).toContain("2026-10-22 08:00 UTC");
    // Never more than one primary button on the page.
    expect(html).not.toContain("kb-btn--primary");
  });

  it("warns on the Permissions tile alone when only permissions are missing", () => {
    const html = page({
      ...calmDashboard(),
      permissions: { state: "ok", value: { problems: 1, unchecked: 0 } },
    });
    expect(html.match(/kb-tile--warn/g)).toHaveLength(1);
    expect(html).toContain(
      '<a class="kb-tile kb-tile--warn" href="/admin/bot-permissions">',
    );
    expect(html).toContain("1 <small>issue</small>");
  });

  it("does not say everything is in place while a switched-on feature was not checked", () => {
    const html = page({
      ...calmDashboard(),
      permissions: { state: "ok", value: { problems: 0, unchecked: 2 } },
    });
    expect(html).toContain("Partly checked");
    expect(html).toContain(
      "2 switched-on features could not be fully checked.",
    );
    expect(html).not.toContain("is in place");
    expect(html).not.toContain("kb-tile--warn");
  });

  it("opens Scan again with a refresh, so it does not show the cached scan", () => {
    const html = page(busyDashboard());
    expect(html).toContain('<a href="/admin/adopt?refresh=1">Scan again</a>');
  });

  it("says a source could not be read instead of showing zero", () => {
    const html = page(busyDashboard());
    expect(html).toContain("The server could not be read from Discord.");
    expect(html).toContain("Unavailable");
    expect(html).toContain(">Disconnected<");
    expect(html).toContain(
      "The counts are unavailable while the database is not connected.",
    );
    expect(html).toContain("Voice activity could not be read just now.");
    const unchecked = page({
      ...calmDashboard(),
      permissions: { state: "unavailable" },
    });
    expect(unchecked).toContain("Not checked");
    expect(unchecked).not.toContain("0 <small>issues</small>");
    expect(unchecked).not.toContain("kb-tile--warn");
  });

  it("shows the weekday bars, names the busiest day and links to Voice analytics", () => {
    const html = page(calmDashboard());
    expect(html).toContain('id="p-voice"');
    expect(html).toContain("Last 7 days · Europe/Oslo");
    expect(html).toContain('href="/admin/analytics"');
    expect(html.match(/kb-bars__row/g)).toHaveLength(7);
    expect(html).toContain("Busiest day: Friday, 3 hr 30 min.");
    expect(html).toContain(
      '<div class="kb-bars__row is-peak"><span>Fri</span>',
    );
    expect(html).toContain("12 hr 20 min in total");
  });

  it("leaves the voice panel out when voice tracking is off, and says when it is empty", () => {
    expect(page({ ...calmDashboard(), voice: null })).not.toContain("p-voice");
    const empty = page({
      ...calmDashboard(),
      voice: {
        state: "ok",
        value: {
          byDay: [0, 0, 0, 0, 0, 0, 0],
          totalMinutes: 0,
          timeZone: "UTC",
        },
      },
    });
    expect(empty).toContain("No voice activity in the last 7 days.");
    expect(empty).not.toContain("kb-bars");
  });

  it("lets the features take the full width when there is nothing for the left column", () => {
    const html = page({ ...calmDashboard(), voice: null });
    expect(html).not.toContain("kb-cols");
    expect(html).toContain('id="p-features"');
  });

  it("lists features with On/Off and the config key, each linking to its page, and has no switch", () => {
    const html = page(calmDashboard());
    expect(html).toContain(
      '<a class="kb-list__link" href="/admin/voice-channels">Voice channels</a><span class="kb-list__sub">voicechannels.enabled</span></span><span class="kb-badge kb-badge--on">On</span>',
    );
    expect(html).toContain('<li class="is-off">');
    expect(html).toContain("3 on · ");
    expect(html).not.toContain("kb-switch");
    expect(html).not.toContain("<form");
  });

  it("keeps the Version panel and its Check now form behind #version", () => {
    const html = page(calmDashboard(), { version: UPDATE_AVAILABLE });
    expect(html).toContain('id="version"');
    expect(html).toContain('action="/admin/version/check"');
    expect(html).toContain('name="_csrf" value="tok"');
    expect(html).toContain("How to update");
  });

  it("escapes every dynamic value", () => {
    const x = '<img src=x onerror="1">';
    const d = calmDashboard();
    d.guild = {
      state: "ok",
      value: {
        id: x,
        name: x,
        memberCount: 1,
        voiceUsers: 0,
        botTag: x,
        connected: true,
      },
    };
    d.mongoState = x;
    d.features = [{ key: x, label: x, href: `/a?b="${x}`, on: true }];
    d.needsYou = [
      { severity: "warning", title: x, detail: x, href: `/a"${x}`, action: x },
    ];
    d.scanReadAt = x;
    d.voice = {
      state: "ok",
      value: { byDay: [1, 0, 0, 0, 0, 0, 0], totalMinutes: 1, timeZone: x },
    };
    const html = page(d);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="1"');
  });
});
