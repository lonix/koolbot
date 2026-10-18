import { describe, it, expect } from "@jest/globals";
import { renderEventsPage } from "../../src/web/admin-views.js";
import { EVENT_GROUP_PRESETS } from "../../src/content/event-group-presets.js";

const COMMON = {
  csrfToken: "csrf-tok",
  remainingMs: 60_000,
  categoryConfigured: true,
  announcementConfigured: true,
  timezone: "UTC",
  settingRows: [],
  enabled: true,
  rows: [],
};

const render = (extra: Record<string, unknown> = {}): string =>
  renderEventsPage({ ...COMMON, ...extra } as never);

describe("renderEventsPage Groups section (#1188)", () => {
  it("is part of the create form and off until ticked", () => {
    const html = render();
    expect(html).toContain("Groups (optional)");
    expect(html).toMatch(/<input type="checkbox" name="groups_enabled"[^>]*>/);
    expect(html).not.toMatch(/name="groups_enabled"[^>]*checked/);
    // Inside the create form, before its submit button.
    const form = html.slice(html.indexOf('action="/admin/events/create"'));
    expect(form.indexOf("groups_enabled")).toBeGreaterThan(-1);
    expect(form.indexOf("groups_enabled")).toBeLessThan(
      form.indexOf("Schedule event</button>"),
    );
  });

  it("offers every built-in preset and Custom, with the groups as data", () => {
    const html = render();
    expect(html).toContain("Custom: any number of groups and names");
    for (const preset of EVENT_GROUP_PRESETS) {
      expect(html).toContain(`value="${preset.id}"`);
    }
    expect(html).toContain("Manticore");
    expect(html).toMatch(/data-groups="\[\{&quot;name&quot;:&quot;Red&quot;/);
  });

  it("renders the configured number of rows, each with labelled fields", () => {
    const html = render({ groupLimits: { defaultCount: 3, maxCount: 6 } });
    const rows = html.match(/name="group_\d+_name"/g) ?? [];
    expect(rows).toHaveLength(3);
    for (const n of [1, 2, 3]) {
      for (const field of ["name", "kind", "size", "tag", "marker"]) {
        expect(html).toContain(`Group ${n} ${field}`);
      }
      expect(html).toContain(`name="group_${n - 1}_name"`);
    }
    expect(html).toContain('data-max="6"');
  });

  it("defaults to two rows and a cap of fifteen, and clamps odd limits", () => {
    expect(render().match(/name="group_\d+_name"/g)).toHaveLength(2);
    expect(render()).toContain('data-max="15"');
    const clamped = render({
      groupLimits: { defaultCount: 99, maxCount: 999 },
    });
    expect(clamped).toContain('data-max="25"');
    expect(clamped.match(/name="group_\d+_name"/g)).toHaveLength(25);
  });

  it("carries the input constraints of the server rules", () => {
    const html = render();
    expect(html).toMatch(/name="group_0_name"[^>]*maxlength="50"/);
    expect(html).toMatch(/name="group_0_size" min="1" max="99"/);
    expect(html).toMatch(/name="group_0_tag"[^>]*maxlength="8"/);
    expect(html).toMatch(/name="groups_lead_minutes" min="0" max="1440"/);
  });

  it("ships a row template and the script for presets, adding rows and inline errors", () => {
    const html = render();
    expect(html).toContain("<template data-group-row-template>");
    expect(html).toContain("group___N___name");
    expect(html).toContain("data-add-group");
    expect(html).toContain("data-group-errors");
    expect(html).toContain("koolbot-event-form-draft");
    // Typing in a row ticks "use groups", so rows are never silently dropped.
    expect(html).toContain(
      "box.addEventListener('input',function(){form.elements['groups_enabled'].checked=true;validity()})",
    );
  });

  it("tells the organiser that each group gets a voice channel", () => {
    const html = render();
    expect(html).toContain("Each group gets its own voice channel");
    expect(html).not.toContain("not created yet");
  });

  it("shows the group count next to the title of an event with groups only", () => {
    const html = render({
      rows: [
        {
          id: "e1",
          title: "Quiz <b>night</b>",
          when: "now",
          state: "scheduled",
          channelId: null,
          groupCount: 4,
        },
        {
          id: "e2",
          title: "Plain",
          when: "now",
          state: "scheduled",
          channelId: null,
        },
      ],
    });
    expect(html).toContain("4 groups");
    expect(html).not.toContain("Quiz <b>night</b>");
    expect(html).toContain("Quiz &lt;b&gt;night&lt;/b&gt;");
    expect(html.match(/ groups?<\/span>/g)).toHaveLength(1);
  });

  it("the page script is valid JavaScript", () => {
    const html = render();
    const scripts = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, code] of scripts) {
      expect(() => new Function(code)).not.toThrow();
    }
  });
});
