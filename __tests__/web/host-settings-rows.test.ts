import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  LEAD_PRESETS,
  LEAD_PRESET_FIELD,
  SWITCH_ROW_IDS,
  prepareSettingsBody,
  renderSettingRow,
  renderSwitchRow,
} from "../../src/web/host-settings-rows.js";
import {
  renderConfirmBody,
  renderEventSettings,
  renderGroupChanges,
  type SettingsViewData,
} from "../../src/web/host-settings-view.js";
import { leadersTagsViewOf } from "../../src/web/host-settings-leaders-tags-view.js";
import { renderUserPage } from "../../src/web/user-layout.js";
import { renderDurationPresets } from "../../src/web/setting-pickers.js";

/**
 * The Event settings rows (#1514): what a switch posts, how the posted form
 * becomes what the live-edit parsers read, the lead time presets, the one save
 * bar, and that no control or button on the fold is left without its kb- class.
 */

const view = (over: Partial<SettingsViewData> = {}): SettingsViewData => ({
  csrfToken: "tok",
  actionPath: (n) => `/me/events/e/host/${n}`,
  blocker: null,
  leadMinutes: 30,
  leadReadOnly: null,
  groupLabel: "Team",
  groups: [],
  leadersTags: leadersTagsViewOf({
    groupsEnabled: true,
    captainsEnabled: true,
    groups: [{ key: "g_00000001", name: "Red", kind: "team" }],
  }),
  ...over,
});

describe("prepareSettingsBody", () => {
  it.each(SWITCH_ROW_IDS.map((id) => [id]))(
    "reads %s shown without a value as an explicit off",
    (id) => {
      const out = prepareSettingsBody({ [`b_${id}`]: "1" });
      expect(out[`s_${id}`]).toBe("0");
    },
  );

  it.each(SWITCH_ROW_IDS.map((id) => [id]))(
    "keeps a posted %s value, on or off",
    (id) => {
      expect(
        prepareSettingsBody({ [`s_${id}`]: "1", [`b_${id}`]: "0" })[`s_${id}`],
      ).toBe("1");
      expect(
        prepareSettingsBody({ [`s_${id}`]: "0", [`b_${id}`]: "1" })[`s_${id}`],
      ).toBe("0");
    },
  );

  it("leaves a row alone when its shown value was not posted (the group forms post to the same action)", () => {
    const out = prepareSettingsBody({ s_groupNameA: "x", b_groupNameA: "y" });
    for (const id of SWITCH_ROW_IDS) expect(`s_${id}` in out).toBe(false);
    expect("s_channelLeadMinutes" in out).toBe(false);
  });

  it("does not change the body it was given", () => {
    const body = { b_tagsEnabled: "1" };
    prepareSettingsBody(body);
    expect(body).toEqual({ b_tagsEnabled: "1" });
  });

  it.each([
    ["default", "", "7"],
    ["30", "30", "7"],
    ["0", "0", "7"],
    // Not a listed preset, "custom" and a crafted value mean the box.
    ["custom", "7", "7"],
    ["45", "7", "7"],
    ["1e3", "7", "7"],
  ])("lead time preset %s posts %j (box %s)", (choice, expected, box) => {
    const out = prepareSettingsBody({
      [LEAD_PRESET_FIELD]: choice,
      s_channelLeadMinutes: box,
      b_channelLeadMinutes: "15",
    });
    expect(out.s_channelLeadMinutes).toBe(expected);
    expect(LEAD_PRESET_FIELD in out).toBe(false);
  });

  it("no preset radio (a script-less crafted post) means the box", () => {
    const out = prepareSettingsBody({
      s_channelLeadMinutes: "12",
      b_channelLeadMinutes: "15",
    });
    expect(out.s_channelLeadMinutes).toBe("12");
  });
});

describe("renderSwitchRow", () => {
  it("is a switch posting 1 with the shown value, named by the row's name and line", () => {
    const html = renderSwitchRow("tagsEnabled", "Clan tags", true, {
      line: "One line.",
      more: "The rest.",
    });
    expect(html).toContain(
      '<input type="checkbox" role="switch" id="host-settings-tagsEnabled-input" name="s_tagsEnabled" value="1" checked aria-labelledby="host-settings-tagsEnabled-name" aria-describedby="host-settings-tagsEnabled-desc">',
    );
    expect(html).toContain(
      '<input type="hidden" name="b_tagsEnabled" value="1">',
    );
    expect(html).toContain('id="host-settings-tagsEnabled-desc">One line.</p>');
    expect(html).toContain("kb-disclosure--inline");
    expect(html).toContain("The rest.");
  });

  it("shows no More when there is nothing more, and escapes", () => {
    const html = renderSettingRow({
      id: "x",
      name: "<b>n</b>",
      line: "<i>l</i>",
      control: "",
    });
    expect(html).not.toContain("kb-disclosure");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });
});

describe("the lead time row", () => {
  const lead = (minutes: number | null): string =>
    renderEventSettings(view({ leadMinutes: minutes, leadersTags: null }));

  it("offers presets, a server-default choice and a bounded box under Custom, bounded 0 to 1440", () => {
    const html = lead(30);
    expect(html).toContain("data-duration");
    expect(html).toContain(`name="${LEAD_PRESET_FIELD}" value="default"`);
    expect(html).toContain("<span>Server default</span>");
    expect(html).toContain("<span>At the start</span>");
    for (const n of LEAD_PRESETS.filter((p) => p > 0)) {
      expect(html).toContain(`name="${LEAD_PRESET_FIELD}" value="${n}"`);
    }
    expect(html).toContain('data-min="0" data-max="1440"');
    // 30 is a preset: ticked, and the box holds it.
    expect(html).toMatch(/value="30" checked>/);
    expect(html).toContain('name="s_channelLeadMinutes" value="30"');
    expect(html).toContain('name="b_channelLeadMinutes" value="30"');
  });

  it("ticks the server default for no stored lead time, with an empty box", () => {
    const html = lead(null);
    expect(html).toMatch(/value="default" checked>/);
    expect(html).toContain('name="s_channelLeadMinutes" value=""');
    expect(html).toContain('name="b_channelLeadMinutes" value=""');
  });

  it("ticks Custom for a stored number that is not a preset", () => {
    const html = lead(45);
    expect(html).toMatch(/value="custom" checked>/);
    expect(html).toContain('name="s_channelLeadMinutes" value="45"');
  });

  it("is text with the reason once the channels exist", () => {
    const html = renderEventSettings(
      view({
        leadMinutes: 15,
        leadReadOnly: "The channels already exist.",
        leadersTags: null,
      }),
    );
    expect(html).toContain("The channels already exist.");
    expect(html).toContain("15 minutes before the start");
    expect(html).not.toContain("s_channelLeadMinutes");
  });
});

describe("renderDurationPresets with a no-value choice", () => {
  const html = (current: string): string =>
    renderDurationPresets(
      "p",
      "v",
      current,
      [5, 15],
      { min: 0, max: 60 },
      { label: "x", unit: "minutes", emptyLabel: "Server default" },
    );

  it("adds a first choice that is ticked only for an empty value", () => {
    expect(html("")).toMatch(/value="default" checked>/);
    expect(html("5")).not.toMatch(/value="default" checked>/);
    expect(html("5")).toMatch(/value="5" checked>/);
  });

  it("is absent without emptyLabel, so the admin presets are unchanged", () => {
    const plain = renderDurationPresets(
      "p",
      "v",
      "",
      [5],
      { min: 0, max: 60 },
      { label: "x", unit: "minutes" },
    );
    expect(plain).not.toContain('value="default"');
    expect(plain).toMatch(/value="custom" checked>/);
  });
});

describe("one SaveBar for the Event settings form", () => {
  const html = renderEventSettings(view());

  it("has one bar inside the form, and its Save is the one primary button", () => {
    expect(html.match(/data-savebar>/g)?.length).toBe(1);
    expect(html.match(/kb-btn--primary/g)?.length).toBe(1);
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    expect(form).toContain('class="kb-savebar"');
    expect(form).toContain('aria-label="Unsaved changes: Event settings"');
    expect(html).not.toContain(">Rename<");
    expect(html).not.toContain("Save settings</button>\n</form>\n<");
  });

  it("is wrapped in rows, so the bar counts a changed row once", () => {
    expect(html).toContain('class="kb-settings"');
    expect(html.match(/class="kb-setting"/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the member layout and a page with a save bar", () => {
  const page = (body: string): string =>
    renderUserPage({
      title: "t",
      active: "/me/events",
      body,
      csrfToken: "c",
      remainingMs: 1000,
      isAdmin: false,
    });

  it("lets the bar wrap on a narrow screen, so clipping main never hides Save (reflow, 1.4.10)", () => {
    const css =
      /<style>([\s\S]*?)<\/style>/.exec(page("<h1>x</h1>"))?.[1] ?? "";
    expect(css).toContain("#main.has-savebar{overflow-x:clip}");
    expect(css).toContain("#main.has-savebar .kb-savebar{flex-wrap:wrap}");
  });

  it("lets the bar stick: has-savebar on main, the bar and preset scripts only where their markup is", () => {
    const withBar = page(renderEventSettings(view()));
    expect(withBar).toMatch(/<main id="main" class="[^"]*has-savebar/);
    expect(withBar).toContain("[data-savebar]");
    expect(withBar).toContain("data-duration-input");
    expect(withBar).toContain("input[data-number]");
    const plain = page("<h1>Hi</h1>");
    expect(plain).not.toContain('has-savebar"');
    expect(plain).not.toContain("[data-savebar]");
    expect(plain).not.toContain("[data-duration]");
  });
});

describe("every control and button of the folds and the confirmation uses the kb- classes (#1514)", () => {
  const folds = [
    renderEventSettings(
      view({
        leaderExtras: {
          leaderLabel: "Captain",
          edits: [{ at: "2030-01-01 19:00", who: "Ana", text: "renamed Red" }],
        },
      }),
    ),
    // No group editor: the read-only table of the groups.
    renderGroupChanges(
      view({
        groups: [
          { name: "Red", marker: "", size: 2, memberCount: 3, overSize: true },
        ],
      }),
    ),
    renderGroupChanges(
      view({
        groupEdit: {
          groupLabel: "Team",
          addKey: "g_0000abcd",
          groups: [
            {
              key: "g_00000001",
              kind: "team",
              hasChannel: true,
              name: "Red",
              marker: "",
              tag: "",
              size: null,
              memberCount: 1,
              overSize: false,
              namePending: false,
              sizePending: false,
            },
            {
              key: "g_00000002",
              kind: "team",
              hasChannel: false,
              name: "Blue",
              marker: "",
              tag: "",
              size: null,
              memberCount: 0,
              overSize: false,
              namePending: false,
              sizePending: false,
            },
          ],
          presets: [{ id: "lib:a", label: "A" }],
          presetNotice: null,
          savePresetHref: null,
          presetBase: "{}",
        } as never,
        groupsSwitch: {
          on: true,
          groupLabel: "Team",
          blocked: null,
          groupCount: 2,
          channelCount: 1,
          channelOwed: true,
          kept: [],
          presets: [],
          presetNotice: null,
        } as never,
        seriesTick: true,
      }),
    ),
    renderConfirmBody({
      csrfToken: "t",
      actionPath: "/a",
      panelPath: "/p",
      token: "k",
      changes: [{ label: "L", from: "a", to: "b" }],
      reasons: ["r"],
    }),
  ].join("\n");
  // Parsed, never regex-filtered; scripts are removed through the DOM (jsdom does not run them).
  const doc = new JSDOM(`<!doctype html><body>${folds}</body>`).window.document;
  doc.querySelectorAll("script").forEach((n) => n.remove());
  const text = doc.body.textContent ?? "";

  it("has no button without a kb-btn class, and no old field, check or muted class", () => {
    const buttons = Array.from(doc.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(5);
    // The marker picker's own button is the shared emoji control, not a form button.
    for (const b of buttons) {
      expect(b.className).toMatch(/^kb-(btn|emoji-btn)/);
    }
    for (const old of ["field", "check", "muted", "mono"]) {
      expect(doc.getElementsByClassName(old)).toHaveLength(0);
    }
    for (const sel of Array.from(doc.querySelectorAll("select"))) {
      expect(sel.classList.contains("kb-select")).toBe(true);
    }
    for (const inp of Array.from(doc.querySelectorAll('input[type="text"]'))) {
      expect(inp.classList.contains("kb-input")).toBe(true);
    }
  });

  it("uses danger for Remove selected and Switch groups off, primary for the two saves, plain for the rest", () => {
    const kind = (label: string): string =>
      Array.from(doc.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      )?.className ?? "";
    expect(kind("Remove selected")).toBe("kb-btn kb-btn--danger");
    expect(kind("Switch groups off")).toBe("kb-btn kb-btn--danger");
    expect(kind("Confirm and save")).toBe("kb-btn kb-btn--primary");
    expect(kind("Save groups")).toBe("kb-btn");
    expect(kind("Add team")).toBe("kb-btn");
    expect(kind("Apply preset")).toBe("kb-btn");
    expect(kind("Create the missing channels")).toBe("kb-btn");
  });

  it("keeps wide tables in their own scroll box, since a page with a save bar clips main sideways", () => {
    const tables = Array.from(doc.querySelectorAll("table"));
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect(t.parentElement?.classList.contains("kb-panel__body--flush")).toBe(
        true,
      );
    }
  });

  it("never repeats an id across the two folds (the series tick is in every form)", () => {
    const ids = Array.from(doc.querySelectorAll("[id]")).map((n) => n.id);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(
      text.match(/Also for the next occurrences/g)?.length,
    ).toBeGreaterThan(2);
  });

  it("keeps the text the confirmation already lists off the page", () => {
    expect(text).not.toContain("its members are unassigned");
    expect(text).not.toContain("Tick the");
  });
});
