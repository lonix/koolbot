/**
 * The host panel leads with the event's state and problems (#1518): a state
 * badge in the h1, the facts as page-header meta, problems as warn callouts
 * above the board, the group facts folded, and End the event as a danger
 * panel that asks in the shared confirm dialog.
 */

import { describe, expect, it } from "@jest/globals";
import {
  eventStateWord,
  renderEventStateBadge,
} from "../../src/web/host-panel-shared.js";
import {
  endEventItems,
  renderEndSection,
} from "../../src/web/event-end-view.js";
import {
  renderHostPanelBody,
  type HostPanelEvent,
  type HostPanelGroup,
} from "../../src/web/host-panel-view.js";

const base: HostPanelEvent = {
  id: "e1",
  title: "Friday night",
  description: "",
  state: "active",
  running: true,
  when: "2030-01-01 19:00 (UTC)",
  durationMinutes: 90,
  recurrence: null,
  channel: "Main <room>",
  channelType: 2,
  groupsEnabled: true,
  groupLabel: "Team",
  leaderLabel: "Leader",
  channelLeadMinutes: null,
  groups: [],
  adopted: false,
};

const team = (over: Partial<HostPanelGroup> = {}): HostPanelGroup => ({
  name: "Reds",
  marker: "",
  kind: "team",
  size: 2,
  tag: "RED",
  hasChannel: true,
  memberCount: 1,
  fill: "1/2",
  ...over,
});

const BOARD = '<section id="host-board">BOARD</section>';

function endHtml(over: Partial<Parameters<typeof renderEndSection>[0]> = {}) {
  return renderEndSection({
    state: "active",
    actionPath: "/me/events/e1/host/end",
    csrfToken: "tok",
    hasGroupChannels: true,
    ...over,
  });
}

function body(over: Partial<HostPanelEvent> = {}, extra = {}): string {
  return renderHostPanelBody({
    event: { ...base, groups: [team()], ...over },
    controls: { board: BOARD, end: endHtml() },
    ...extra,
  });
}

describe("eventStateWord", () => {
  it.each([
    ["active", true, "Live", "on"],
    ["active", false, "Planned", "info"],
    ["scheduled", false, "Planned", "info"],
    ["ended", false, "Ended", "info"],
    ["cancelled", false, "Cancelled", "off"],
    ["odd", false, "odd", "info"],
  ] as const)("%s (running %s) reads %s", (state, running, label, tone) => {
    expect(eventStateWord(state, running)).toEqual({ label, tone });
  });

  it("renders the badge with the word, escaped", () => {
    expect(renderEventStateBadge("active", true)).toBe(
      '<span class="kb-badge kb-badge--on">Live</span>',
    );
    expect(renderEventStateBadge("<x>", false)).toContain("&lt;x&gt;");
  });
});

describe("the header", () => {
  it("has the state badge in the h1 and no Summary card", () => {
    const html = body();
    expect(html).toMatch(
      /<h1 class="kb-pagehead__title">Host panel <span class="kb-badge kb-badge--on">Live<\/span><\/h1>/,
    );
    expect(html).not.toContain("host-summary");
    expect(html).not.toContain('class="tag ');
    expect(html).not.toContain(">Summary<");
    expect(html).toContain('<a href="/me/events">Your events</a>');
    expect(html).toContain("<strong>Friday night</strong>");
  });

  it("says Planned for an active event that has not started, and Ended for an ended one", () => {
    expect(body({ running: false })).toContain("Planned</span></h1>");
    expect(body({ state: "ended", running: false })).toContain(
      "Ended</span></h1>",
    );
  });

  it("states the start, duration, repeats and main channel as meta spans with icons", () => {
    const html = body({ recurrence: "weekly" });
    const meta = html.match(
      /<p class="kb-pagehead__meta">([\s\S]*?)<\/p>/,
    )?.[1] as string;
    expect(meta).toBeDefined();
    expect(meta).toContain("Starts 2030-01-01 19:00 (UTC)");
    expect(meta).toContain("90 minutes");
    expect(meta).toContain("Repeats weekly");
    expect(meta).toContain("Main &lt;room&gt;");
    expect(meta.match(/<span>/g)?.length).toBeGreaterThanOrEqual(4);
    expect(meta).toContain('class="kb-icon"');
    expect(html).not.toContain("prefs-table");
  });

  it("says the main channel is not created yet, and keeps the adopted-event fact", () => {
    const html = body({ channel: null, adopted: true });
    expect(html).toContain("Main channel not created yet");
    expect(html).toContain(
      "Existing Discord event; KoolBot reads it but never changes it.",
    );
    expect(body({ recurrence: null })).not.toContain("Repeats");
  });

  it("shows the description as a line under the title, escaped, only when there is one", () => {
    const html = body({ description: "Bring <snacks>" });
    expect(html).toContain("Bring &lt;snacks&gt;");
    expect(html).not.toContain("Bring <snacks>");
    expect(body()).not.toContain('kb-pagehead__sub"></p>');
  });
});

describe("problems come first", () => {
  const withProblems = (): string =>
    body(
      {
        groupNotices: ["No <b>permission</b>"],
        tagsEnabled: true,
        tagNotices: ["No Manage Nicknames"],
        tagSkipped: [{ name: "Owner", reason: "Cannot be changed." }],
      },
      {
        permissionNotice: {
          unavailable: null,
          missing: [
            {
              feature: {
                id: "event-channels",
                area: "Events",
                feature: "Event channels",
                effect: "Channels cannot be made.",
              },
              permissions: ["Manage Channels"],
              target: { kind: "server", id: "g", name: "Server" },
            },
          ],
          unchecked: [],
          stale: false,
        } as never,
      },
    );

  it("renders the permission notice and both warnings as warn callouts before the board", () => {
    const html = withProblems();
    const board = html.indexOf('id="host-board"');
    const perm = html.indexOf("The bot is missing a Discord permission");
    const group = html.indexOf("Some group channels could not be set up");
    const tags = html.indexOf("No Manage Nicknames");
    expect(perm).toBeGreaterThan(html.indexOf("</header>"));
    for (const at of [perm, group, tags]) {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(board);
    }
    expect(html).toMatch(
      /<div class="kb-callout kb-callout--warn" role="status"[^>]*>[\s\S]*?Some group channels could not be set up/,
    );
    expect(html).toContain("No &lt;b&gt;permission&lt;/b&gt;");
    expect(html).not.toContain("<b>permission</b>");
    expect(html).not.toContain('class="notice');
  });

  it("does not repeat the warnings inside the groups fold", () => {
    const html = withProblems();
    const fold = html.slice(html.indexOf('id="host-groups"'));
    const foldBody = fold.slice(0, fold.indexOf("</details>"));
    expect(foldBody).not.toContain("No Manage Nicknames");
    expect(foldBody).not.toContain("could not be set up");
    // Who could not be tagged stays, in the fold.
    expect(foldBody).toContain("Owner: Cannot be changed.");
  });

  it("shows no callout when nothing is wrong", () => {
    const html = body();
    expect(html).not.toContain("kb-callout");
    expect(html).not.toContain("could not be set up");
  });
});

describe("the groups fold", () => {
  it("is a closed kb-disclosure after the board and before End the event", () => {
    const html = body({
      captainsEnabled: true,
      captainsLobby: { hasChannel: false },
      tagsEnabled: true,
      channelLeadMinutes: 20,
    });
    expect(html).toMatch(/<details class="kb-disclosure" id="host-groups">/);
    const at = html.indexOf('id="host-groups"');
    expect(at).toBeGreaterThan(html.indexOf('id="host-board"'));
    expect(at).toBeLessThan(html.indexOf('id="host-end"'));
    const fold = html.slice(at, html.indexOf("</details>", at));
    expect(fold).toContain("kb-disclosure__hint");
    expect(fold).toContain("20 minutes before the start");
    expect(fold).toContain("Captains lobby:");
    expect(fold).toContain("its channel is not created yet");
    expect(fold).toContain("Clan tags");
    expect(fold).toContain("Members");
    expect(fold).toContain('<table class="kb-table">');
    expect(html).not.toContain('section class="card" id="host-groups"');
  });

  it("keeps every column and fact of the old table (nothing disappears)", () => {
    const html = body({
      captainsEnabled: true,
      groups: [
        team({ leaderName: "Ann" }),
        team({ name: "Guests", kind: "open", size: null, tag: "" }),
      ],
    });
    const fold = html.slice(html.indexOf('id="host-groups"'));
    for (const h of ["Who", "Size", "Tag", "Channel", "People", "Leader"]) {
      expect(fold).toContain(`>${h}</th>`);
    }
    expect(fold).toContain("Open to anyone");
    expect(fold).toContain("Ann");
    expect(fold).toContain("1/2");
  });

  it("is not on the page for an event without groups", () => {
    const html = body({ groupsEnabled: false, groups: [] });
    expect(html).not.toContain('id="host-groups"');
    expect(html).not.toContain("This event has no groups");
  });

  it("is still on a read-only page, where there is no board", () => {
    const html = renderHostPanelBody({
      event: { ...base, state: "ended", running: false, groups: [team()] },
    });
    expect(html).toContain('id="host-groups"');
    expect(html).toContain("This event is ended, so this page is a read-only");
    expect(html).not.toContain('id="host-end"');
  });
});

describe("the read-only notice uses the state word", () => {
  it.each([
    ["ended", "This event is ended"],
    ["cancelled", "This event is cancelled"],
  ])("%s", (state, text) => {
    const html = renderHostPanelBody({
      event: { ...base, state, running: false },
    });
    expect(html).toContain(text);
    expect(html).toContain("kb-callout");
  });
});

describe("End the event", () => {
  it("is a danger panel with one line and a danger button that opens the dialog", () => {
    const html = body();
    expect(html).toMatch(
      /<section class="kb-panel kb-panel--danger" id="host-end" aria-labelledby="host-end-h">/,
    );
    expect(html).toContain('<h2 class="kb-panel__title" id="host-end-h">');
    expect(html).toContain("End the event");
    const form = html.match(/<form[^>]*end-event-form[\s\S]*?<\/form>/)?.[0];
    expect(form).toBeDefined();
    expect(form).toContain('data-confirm="End this event now?"');
    expect(form).toContain("data-confirm-list=");
    expect(form).toContain('name="_csrf"');
    expect(form).toMatch(
      /<button type="submit" class="kb-btn kb-btn--danger" name="confirm" value="1">End event now<\/button>/,
    );
    expect(form).not.toContain('btn-danger"');
  });

  it("keeps a deliberate confirmation without JavaScript: a required checkbox inside noscript", () => {
    const form = endHtml();
    expect(form).toMatch(
      /<noscript>[\s\S]*<input type="checkbox" name="confirm" value="1" required>[\s\S]*<\/noscript>/,
    );
    // The consequences are readable there too, since no dialog will show them.
    expect(form.match(/<noscript>[\s\S]*<\/noscript>/)?.[0]).toContain(
      "This cannot be undone",
    );
  });

  it("lists today's consequences in the dialog", () => {
    const list = JSON.parse(
      (endHtml().match(/data-confirm-list="([^"]*)"/)?.[1] ?? "[]")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    ) as string[];
    expect(list).toEqual(endEventItems(true, false));
  });

  it("is a plain panel with one muted sentence and no form before the start", () => {
    const html = renderHostPanelBody({
      event: { ...base, state: "scheduled", running: false },
      controls: {
        board: BOARD,
        end: endHtml({ state: "scheduled" }),
      },
    });
    const panel = html.slice(html.indexOf('id="host-end"'));
    expect(panel).toContain("Only a running event can be ended");
    expect(html).not.toContain("kb-panel--danger");
    expect(html).toContain('id="host-end"');
    expect(html).not.toContain('action="/me/events/e1/host/end"');
  });
});

describe("endEventItems", () => {
  it.each([
    [
      true,
      false,
      [
        "moved back to the main channel first",
        "group channels are then removed",
        "group leaders are cleared",
        "the Discord event is closed",
      ],
    ],
    [false, false, ["the Discord event is closed"]],
    [true, true, ["left as it is"]],
  ])("group channels %s, adopted %s", (groups, adopted, has) => {
    const text = endEventItems(groups, adopted).join(" ");
    for (const part of has)
      expect(text.toLowerCase()).toContain(part.toLowerCase());
    expect(text).toContain(
      "main channel is removed after the usual grace period",
    );
    expect(text).toContain("cannot be undone");
    expect(text.includes("moved back")).toBe(groups);
    expect(text.includes("is closed")).toBe(!adopted);
    expect(endEventItems(groups, adopted).at(-1)).toBe(
      "This cannot be undone.",
    );
  });
});
