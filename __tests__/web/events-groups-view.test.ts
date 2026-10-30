import { describe, it, expect } from "@jest/globals";
import { renderEventsPage } from "../../src/web/admin-views.js";
import { renderAdminNewEvent } from "./new-event-page-helper.js";
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
  renderAdminNewEvent({ ...COMMON, ...extra } as never);

describe("the New event page Groups section (#1188)", () => {
  it("is part of the create form and off until ticked", () => {
    const html = render();
    expect(html).toContain("Split into groups (teams, squads, rooms…)");
    expect(html).toMatch(
      /<input type="checkbox" role="switch" name="groups_enabled"[^>]*>/,
    );
    expect(html).not.toMatch(/name="groups_enabled"[^>]*checked/);
    // Inside the create form, before its submit button.
    const form = html.slice(html.indexOf('action="/admin/events/create"'));
    expect(form.indexOf("groups_enabled")).toBeGreaterThan(-1);
    expect(form.indexOf("groups_enabled")).toBeLessThan(
      form.indexOf("Create event</button>"),
    );
  });

  it("offers every built-in preset and Custom, with the groups as data", () => {
    const html = render();
    // Choice cards (radios), Custom last and chosen by default.
    expect(html).toContain(
      'role="radiogroup" aria-labelledby="groups-setup-label"',
    );
    for (const preset of EVENT_GROUP_PRESETS) {
      expect(html).toContain(
        `<input type="radio" name="groups_preset" value="${preset.id}"`,
      );
    }
    expect(html).toContain(
      '<input type="radio" name="groups_preset" value="" checked>',
    );
    expect(html.indexOf('value="" checked')).toBeGreaterThan(
      html.indexOf(`value="${EVENT_GROUP_PRESETS.at(-1)?.id}"`),
    );
    expect(html).not.toContain('<select name="groups_preset"');
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
    expect(html).toMatch(/name="group_0_size"[^>]*min="1" max="99"/);
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
      "box.addEventListener('input',function(e){enabled.checked=true;",
    );
  });

  /** The section's markup, from its fieldset to the closing tag. */
  const section = (): string => {
    const html = render();
    const start = html.indexOf("<fieldset data-groups-section>");
    return html.slice(start, html.indexOf("</fieldset>", start));
  };

  it("renders everything open for a browser without scripts (#1299)", () => {
    const s = section();
    // The scripts fold the body, the nested options and the rows; the server
    // renders none of them folded.
    expect(s).toMatch(/<div data-groups-body[^>]*>/);
    expect(s).not.toMatch(/<div data-groups-body[^>]*hidden/);
    expect(s).not.toMatch(/<div class="kb-nested"[^>]*hidden/);
    expect(s).not.toMatch(/<div data-group-editor[^>]*hidden/);
    expect(s).toContain(
      '<details class="kb-disclosure" data-groups-advanced open>',
    );
    // What only works with scripts is the only thing that starts hidden.
    for (const marker of [
      "data-preset-summary",
      "data-customise",
      "data-group-builder",
      "data-size-quick",
      "data-marker-btn",
      "data-kind-toggle",
    ]) {
      expect(s).toMatch(new RegExp(`${marker}[^>]*hidden`));
    }
    // The kind select and the marker text box are there to be used.
    expect(s).toContain('name="group_0_kind">');
    expect(s).toMatch(/data-marker-input[^>]*name="group_0_marker"/);
  });

  it("nests the options that depend on another under their parent, never greyed out (#1299)", () => {
    const s = section();
    const captains = s.indexOf('data-nested-for="groups_captains"');
    const tags = s.indexOf('data-nested-for="groups_tags"');
    const advanced = s.indexOf("data-groups-advanced");
    expect(s.indexOf('name="groups_captains"')).toBeLessThan(captains);
    expect(captains).toBeLessThan(tags);
    // Leader wording, customise and the captains lobby sit under Group leaders.
    const leaders = s.slice(captains, tags);
    for (const name of [
      "groups_leader_label",
      "groups_captain_custom",
      "groups_captains_lobby",
    ]) {
      expect(leaders).toContain(`name="${name}"`);
      expect(s).not.toMatch(new RegExp(`name="${name}"[^>]*disabled`));
    }
    // Only "tag after the name" sits under Clan tags.
    expect(s.indexOf('name="groups_tags"')).toBeLessThan(tags);
    const clan = s.slice(tags, advanced);
    expect(clan).toContain('name="groups_tags_suffix"');
    expect(clan).not.toContain('name="groups_captains');
  });

  it("keeps the rarely changed fields in an Advanced section, with short labels and help text (#1299)", () => {
    const s = section();
    const at = s.indexOf("data-groups-advanced");
    const advanced = s.slice(at);
    expect(advanced).toContain('name="groups_label"');
    expect(advanced).toContain('name="groups_lead_minutes"');
    // The leader wording sits under Group leaders, not here.
    expect(advanced).not.toContain('name="groups_leader_label"');
    expect(s).not.toContain("Group leaders: the host picks");
    expect(s).toContain('id="groups-captains-help"');
    expect(s).toContain("Tag after the name");
  });

  it("sizes the fields to their content, without inline styles (#1299)", () => {
    const s = section();
    expect(s).toContain("kb-input kb-input--sm kb-input--num");
    expect(s).toContain('class="kb-grouprow"');
    expect(s).not.toContain("style=");
  });

  it("tells the organiser that each group gets a voice channel", () => {
    const html = render();
    expect(html).toContain("Each group gets its own voice channel");
    expect(html).not.toContain("not created yet");
  });

  it("shows the group count next to the title of an event with groups only", () => {
    const html = renderEventsPage({
      ...COMMON,
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
    expect(html.match(/title="Groups set up for this event"/g)).toHaveLength(1);
  });

  describe("remembered setup (#1406)", () => {
    const prefill = {
      presetId: "",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      channelLeadMinutes: "10",
      rows: [
        { name: "Red", kind: "team", size: "5", tag: "RED", marker: "🔴" },
        { name: "Blue", kind: "open", size: "", tag: "", marker: "" },
        { name: "Green", kind: "team", size: "", tag: "", marker: "" },
      ],
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      captainsLobby: false,
      tagsEnabled: true,
      tagsSuffix: true,
    };
    const remembered = (p: Record<string, unknown> = {}): unknown => ({
      prefill: { ...prefill, ...p },
      resetHref: "/admin/events/new?defaults=1",
    });

    it("prefills rows, switches, wording and lead time, and says so", () => {
      const html = render({ groupRemembered: remembered() });
      expect(html).toContain("Prefilled from your last event.");
      expect(html).toContain(
        '<a href="/admin/events/new?defaults=1">Start from the defaults instead</a>',
      );
      expect(html).toMatch(/name="groups_enabled" value="1" checked/);
      expect(html).toMatch(/name="groups_captains" value="1" checked/);
      expect(html).toMatch(/name="groups_captain_custom" value="1" checked/);
      expect(html).not.toMatch(
        /name="groups_captains_lobby" value="1" checked/,
      );
      expect(html).toMatch(/name="groups_tags" value="1" checked/);
      expect(html).toMatch(/name="groups_tags_suffix" value="1" checked/);
      // Three stored rows, more than the two the form shows by default.
      expect(html).toMatch(/name="group_0_name"[^>]*value="Red"/);
      expect(html).toMatch(/name="group_0_marker"[^>]*value="🔴"/);
      expect(html).toMatch(/name="group_0_size"[^>]*value="5"/);
      expect(html).toMatch(/name="group_2_name"[^>]*value="Green"/);
      expect(html).toContain('<option value="open" selected>');
      // Listed words are the dropdown's chosen option (#1471), not text in the box.
      expect(html).toContain('<option value="Squad" selected>');
      expect(html).toContain('<option value="Captain" selected>');
      expect(html).toMatch(/name="groups_lead_minutes"[^>]*value="10"/);
    });

    it("checks the remembered preset card and unchecks Custom", () => {
      const id = EVENT_GROUP_PRESETS[0].id;
      const html = render({
        groupRemembered: remembered({ presetId: id, rows: prefill.rows }),
      });
      expect(html).toMatch(
        new RegExp(`name="groups_preset" value="${id}"[^>]* checked`),
      );
      expect(html).not.toMatch(/name="groups_preset" value="" checked/);
    });

    it("escapes remembered text", () => {
      const html = render({
        groupRemembered: remembered({
          rows: [
            {
              name: '"><script>x</script>',
              kind: "team",
              size: "",
              tag: "",
              marker: "",
            },
          ],
        }),
      });
      expect(html).not.toContain("<script>x</script>");
      expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    });

    it("renders exactly the old form without a remembered setup", () => {
      const html = render({ groupRemembered: null });
      expect(html).not.toContain("Prefilled from your last event.");
      expect(html).not.toMatch(/name="groups_enabled"[^>]*checked/);
      expect(html).toMatch(/name="groups_preset" value="" checked/);
      expect(html).not.toMatch(/name="groups_label"[^>]*value=/);
      expect(html).not.toMatch(/name="groups_lead_minutes"[^>]*value=/);
      expect(html).toBe(render());
    });
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
