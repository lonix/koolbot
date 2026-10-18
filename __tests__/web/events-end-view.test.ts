import { describe, it, expect } from "@jest/globals";
import { renderEventsPage } from "../../src/web/admin-views.js";
import {
  END_CONFIRM_FIELD,
  END_PULL_BACK_FIELD,
  renderEndEventForm,
  renderEndSection,
} from "../../src/web/event-end-view.js";

const COMMON = {
  csrfToken: "csrf-tok",
  remainingMs: 60_000,
  categoryConfigured: true,
  announcementConfigured: true,
  timezone: "UTC",
  settingRows: [],
  enabled: true,
};

function row(extra: Record<string, unknown>) {
  return {
    id: "e1",
    title: "Game <b>Night</b>",
    when: "2026-07-04 20:00 (UTC)",
    state: "active",
    channelId: "c1",
    ...extra,
  };
}

function endForm(html: string): string {
  return (
    (html.match(/<form[^>]*end-event-form[\s\S]*?<\/form>/) ?? [])[0] ?? ""
  );
}

describe("renderEventsPage: End now (#1193)", () => {
  it("offers a confirmed End now form on a running event, with CSRF", () => {
    const html = renderEventsPage({ ...COMMON, rows: [row({})] } as never);
    const form = endForm(html);
    expect(form).toContain('action="/admin/events/e1/end-now"');
    expect(form).toContain('method="POST"');
    expect(form).toContain('name="_csrf" value="csrf-tok"');
    expect(form).toContain(
      `<input type="checkbox" name="${END_CONFIRM_FIELD}" value="1" required>`,
    );
    expect(html).toContain('<details class="end-now">');
    // No pull-back for an event without group channels.
    expect(form).not.toContain(END_PULL_BACK_FIELD);
  });

  it("offers the pull-back, ticked, only when the event has group channels", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [row({ groupCount: 2, hasGroupChannels: true })],
    } as never);
    expect(endForm(html)).toContain(
      `<input type="checkbox" name="${END_PULL_BACK_FIELD}" value="1" checked>`,
    );
    const noChannels = renderEventsPage({
      ...COMMON,
      rows: [row({ groupCount: 2, hasGroupChannels: false })],
    } as never);
    expect(endForm(noChannels)).not.toContain(END_PULL_BACK_FIELD);
  });

  it.each(["scheduled", "ended", "cancelled"])(
    "has no End now for a %s event",
    (state) => {
      const html = renderEventsPage({
        ...COMMON,
        rows: [row({ state })],
      } as never);
      expect(html).not.toContain("end-now");
      expect(html).not.toContain("End event now");
    },
  );

  it("keeps Start now and Cancel next to it", () => {
    const html = renderEventsPage({ ...COMMON, rows: [row({})] } as never);
    expect(html).toContain('action="/admin/events/e1/start-now"');
    expect(html).toContain('action="/admin/events/e1/cancel"');
    expect(html).toContain("Host panel");
  });

  it("escapes the id in the action", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [row({ id: 'e"><script>1</script>' })],
    } as never);
    expect(html).not.toContain("<script>1</script>");
  });
});

describe("renderEndEventForm and renderEndSection", () => {
  const base = {
    actionPath: '/x/"><i>',
    csrfToken: '"><b>',
    idSuffix: "a<b>",
    offerPullBack: true,
  };

  it("escapes every value", () => {
    const html = renderEndEventForm(base);
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;");
  });

  it("says what ending does, including the leaders and the grace period", () => {
    const html = renderEndEventForm(base);
    expect(html).toContain("stops its reminders and host actions");
    expect(html).toContain("group leaders are cleared");
    expect(html).toContain("usual grace period");
    expect(html).toContain("cannot be undone");
    const plain = renderEndEventForm({ ...base, offerPullBack: false });
    expect(plain).not.toContain("group leaders");
  });

  it("gives the form a description for assistive technology", () => {
    const html = renderEndEventForm({ ...base, idSuffix: "x" });
    expect(html).toContain('aria-describedby="end-x-what"');
    expect(html).toContain('id="end-x-what"');
  });

  it("the section is the form for a running event, and an explanation otherwise", () => {
    expect(
      renderEndSection({
        state: "active",
        actionPath: "/p/end",
        csrfToken: "t",
        offerPullBack: false,
      }),
    ).toContain('action="/p/end"');
    const scheduled = renderEndSection({
      state: "scheduled",
      actionPath: "/p/end",
      csrfToken: "t",
      offerPullBack: true,
    });
    expect(scheduled).not.toContain("<form");
    expect(scheduled).toContain("Only a running event can be ended");
  });
});
