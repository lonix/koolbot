/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * The host panel's team board and toolbar (#1424): the markup is plain forms
 * that work with scripts off, and the page script only upgrades it.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  renderHostBoard,
  HOST_BOARD_SCRIPT,
  type HostBoardData,
} from "../../src/web/host-board-view.js";

const PANEL = "/me/events/e1/host";

function data(over: Partial<HostBoardData> = {}): HostBoardData {
  return {
    csrfToken: "tok<1>",
    actionPath: (n) => `${PANEL}/${n}`,
    groupLabel: "Team",
    leaderLabel: "Captain",
    locked: false,
    presenceOk: true,
    teams: [
      {
        key: "g_a",
        name: "Reds <b>",
        marker: "R",
        tag: "RED",
        size: 2,
        hasChannel: true,
        customised: false,
        people: [
          {
            id: "111111111111111111",
            name: "Ana",
            connected: true,
            where: "Reds <b>",
            leaderLabel: null,
          },
          {
            id: "222222222222222222",
            name: "Ben",
            connected: false,
            where: null,
            leaderLabel: null,
          },
        ],
      },
      {
        key: "g_b",
        name: "Blues",
        marker: "",
        tag: "",
        size: null,
        hasChannel: false,
        customised: true,
        people: [],
      },
    ],
    loose: [
      {
        id: "333333333333333333",
        name: "Cal",
        connected: true,
        where: "Main channel",
        leaderLabel: null,
      },
    ],
    connectedCount: 2,
    moveBlocker: null,
    sendableTeams: 1,
    waitingForChannel: 0,
    hasMain: true,
    destinations: [
      { value: "main", label: "Main channel", occupants: 1, limit: 0 },
      { value: "g_a", label: "R Reds <b>", occupants: 2, limit: 2 },
    ],
    movePeople: [{ id: "111111111111111111", name: "Ana", where: "Main" }],
    ...over,
  };
}

describe("the toolbar", () => {
  it("is Lock, then Randomise… and Move people…, then Send to teams, each a form or a disclosure that works without script", () => {
    const html = renderHostBoard(data());
    const bar = html.slice(html.indexOf('role="group"'));
    const order = [
      "Unlocked",
      "Lock groups",
      "Randomise…",
      "Move people…",
      "Send to teams",
    ].map((t) => bar.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The option sets are disclosures first (no script needed to reach them).
    expect(html).toMatch(
      /<details class="kb-toolbar__action" id="host-randomise"/,
    );
    expect(html).toMatch(
      /<details class="kb-toolbar__action" id="host-move-people"/,
    );
    for (const action of [
      "lock",
      "randomise",
      "return-to-main",
      "move-one",
      "send-to-groups",
    ]) {
      expect(html).toContain(`action="${PANEL}/${action}"`);
    }
  });

  it("shows Locked with Unlock groups, and posts the new state", () => {
    const html = renderHostBoard(data({ locked: true }));
    expect(html).toContain("Locked");
    expect(html).toContain("Unlock groups");
    expect(html).toContain('name="locked" value="0"');
    expect(html).toContain("no longer changes who is in which team");
  });

  it("names the people Randomise deals and offers both modes", () => {
    const html = renderHostBoard(data({ connectedCount: 1 }));
    expect(html).toContain("Deal 1 person");
    expect(html).toContain('name="mode" value="unassigned" checked');
    expect(html).toContain('name="mode" value="everyone"');
  });

  it("switches Randomise off when the voice state is unreadable, and adding to a team with it", () => {
    const html = renderHostBoard(
      data({ presenceOk: false, loose: [], connectedCount: 0 }),
    );
    expect(html).toContain("could not read who is in the voice channels");
    expect(html).not.toContain(`action="${PANEL}/randomise"`);
    expect(html).not.toContain('data-board-do="assign"');
    // Taking a person out of a team stays possible.
    expect(html).toContain(`formaction="${PANEL}/unassign"`);
  });

  it("switches Move people and Send to teams off with the reason, and keeps the forms out of reach", () => {
    const html = renderHostBoard(
      data({ moveBlocker: "The bot lacks Move Members." }),
    );
    expect(html).toContain("The bot lacks Move Members.");
    expect(html).not.toContain(`action="${PANEL}/return-to-main"`);
    expect(html).toMatch(
      /<button class="kb-btn kb-btn--primary" type="submit" disabled aria-disabled="true" aria-describedby="host-board-notes">Send to teams<\/button>/,
    );
  });

  it("says why Send to teams is off when no team has a channel, and who is waiting", () => {
    const html = renderHostBoard(
      data({ sendableTeams: 0, waitingForChannel: 2 }),
    );
    expect(html).toContain("nowhere to send people");
    expect(html).toContain("2 assigned people are in a team without a channel");
  });

  it("shows the pull form only while leaders are on, and never posts a channel id", () => {
    expect(renderHostBoard(data())).not.toContain("pull-leaders");
    const html = renderHostBoard(
      data({
        leaders: {
          defaultWhere: "the main channel.",
          destinations: [
            { value: "default", label: "Default" },
            { value: "g_a", label: "Reds" },
          ],
        },
      }),
    );
    expect(html).toContain(`action="${PANEL}/pull-leaders"`);
    expect(html).toContain("Pull captains only");
    expect(html).not.toMatch(/value="c-/);
  });
});

describe("the board", () => {
  it("has a column per team plus Not in a team, each labelled, with its count and fill", () => {
    const html = renderHostBoard(data());
    expect(html.match(/class="kb-board__col"/g)).toHaveLength(2);
    expect(html).toContain('id="host-board-loose"');
    expect(html).toContain("Not in a team");
    expect(html).toContain("2 people, limit 2");
    expect(html).toContain('aria-label="2 of 2 places taken"');
    expect(html).toContain("Nobody here yet.");
  });

  it("escapes every name, tag and token", () => {
    const html = renderHostBoard(data());
    expect(html).toContain("R Reds &lt;b&gt;");
    expect(html).not.toContain("Reds <b>");
    expect(html).toContain("tok&lt;1&gt;");
    expect(html).not.toContain("tok<1>");
  });

  it("shows where each person is connected now, and Not connected for an absent member", () => {
    const html = renderHostBoard(data());
    expect(html).toContain("In Reds &lt;b&gt;");
    expect(html).toContain("In Main channel");
    expect(html).toContain("Not connected");
  });

  it("gives each person a labelled team menu: the no-JavaScript way to move them", () => {
    const html = renderHostBoard(data());
    const ana = html.slice(html.indexOf('data-user="111111111111111111"'));
    const li = ana.slice(0, ana.indexOf("</li>"));
    expect(li).toContain(`action="${PANEL}/assign"`);
    expect(li).toContain('name="userId" value="111111111111111111"');
    expect(li).toContain("Team for Ana");
    expect(li).toContain('<option value="g_a" selected>');
    expect(li).toContain(`formaction="${PANEL}/unassign"`);
    // Every select has a label of its own, unique per person.
    expect(html).toContain('for="board-move-333333333333333333"');
    expect(html).toContain('id="board-move-333333333333333333"');
    // A person in no team has no unassign button.
    const cal = html.slice(html.indexOf('data-user="333333333333333333"'));
    expect(cal.slice(0, cal.indexOf("</li>"))).not.toContain("unassign");
  });

  it("disables a full team as a choice, except for its own members", () => {
    const html = renderHostBoard(
      data({
        teams: data().teams.map((t, i) =>
          i === 0
            ? {
                ...t,
                people: [
                  ...t.people,
                  {
                    id: "444444444444444444",
                    name: "Dee",
                    connected: true,
                    where: "Main",
                    leaderLabel: null,
                  },
                ].slice(0, 2),
              }
            : t,
        ),
      }),
    );
    const cal = html.slice(html.indexOf('data-user="333333333333333333"'));
    expect(cal.slice(0, cal.indexOf("</li>"))).toContain(
      '<option value="g_a" disabled>R Reds &lt;b&gt; (2/2, full)</option>',
    );
    const ana = html.slice(html.indexOf('data-user="111111111111111111"'));
    expect(ana.slice(0, ana.indexOf("</li>"))).toContain(
      '<option value="g_a" selected>',
    );
  });

  it("marks a leader with a visible label and offers Make or Remove, per person", () => {
    const withLeader = data({
      leaders: { defaultWhere: "x", destinations: [] },
      teams: data().teams.map((t, i) =>
        i === 0
          ? {
              ...t,
              people: t.people.map((p, j) =>
                j === 0 ? { ...p, leaderLabel: "Captain" } : p,
              ),
            }
          : t,
      ),
    });
    const html = renderHostBoard(withLeader);
    expect(html).toContain("Captain</span>");
    expect(html).toContain("Remove as captain");
    expect(html).toContain("Make captain");
    expect(html).toContain('name="group" value="g_a"');
    // Remove posts an empty userId, as the old form's "No leader" did.
    expect(html).toContain('name="userId" value=""');
    expect(renderHostBoard(data())).not.toContain("set-leader");
  });

  it("offers a reset only on a team a leader changed", () => {
    const html = renderHostBoard(data());
    expect(html.match(/\/reset-team"/g)).toHaveLength(1);
    expect(html).toContain('name="group" value="g_b"');
  });

  it("says so when there is no team at all", () => {
    const html = renderHostBoard(data({ teams: [], loose: [] }));
    expect(html).toContain("There is no team to put people in yet");
    expect(html).not.toContain("kb-board__col");
  });

  it("uses only kb- classes and no inline handler", () => {
    const html = renderHostBoard(data());
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) =>
      m[1].split(/\s+/),
    );
    expect(classes.filter((c) => c && !c.startsWith("kb-"))).toEqual([]);
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("the page script (progressive enhancement)", () => {
  function setup(html: string): void {
    document.body.innerHTML = html;
    // jsdom has no dialog or form submission: stand in for both.
    const proto = globalThis.HTMLDialogElement?.prototype as unknown as Record<
      string,
      unknown
    >;
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    for (const f of Array.from(document.querySelectorAll("form"))) {
      (f as unknown as Record<string, unknown>).requestSubmit = jest.fn();
    }
    new Function(HOST_BOARD_SCRIPT)();
  }

  function drop(person: Element, col: Element): void {
    person.dispatchEvent(new Event("dragstart", { bubbles: true }));
    col.dispatchEvent(
      new Event("dragover", { bubbles: true, cancelable: true }),
    );
    col.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  }

  it("makes people draggable and submits the person's own assign form on a drop", () => {
    setup(renderHostBoard(data()));
    const cal = document.querySelector('[data-user="333333333333333333"]')!;
    expect(cal.getAttribute("draggable")).toBe("true");
    const form = cal.querySelector(
      "form[data-board-assign]",
    ) as HTMLFormElement & { requestSubmit: jest.Mock };
    drop(cal, document.querySelector('.kb-board__col[data-group="g_b"]')!);
    expect(
      (form.querySelector("select[name=group]") as HTMLSelectElement).value,
    ).toBe("g_b");
    expect(form.requestSubmit).toHaveBeenCalledTimes(1);
    expect(form.requestSubmit.mock.calls[0][0]).toBe(
      form.querySelector("[data-board-do=assign]"),
    );
  });

  it("submits the unassign button when a person is dropped on Not in a team", () => {
    setup(renderHostBoard(data()));
    const ana = document.querySelector('[data-user="111111111111111111"]')!;
    const form = ana.querySelector(
      "form[data-board-assign]",
    ) as HTMLFormElement & { requestSubmit: jest.Mock };
    drop(ana, document.getElementById("host-board-loose")!);
    expect(form.requestSubmit.mock.calls[0][0]).toBe(
      form.querySelector("[data-board-do=unassign]"),
    );
  });

  it("does nothing for the same column, and says so in words for a full team", () => {
    setup(renderHostBoard(data()));
    const ana = document.querySelector('[data-user="111111111111111111"]')!;
    const form = ana.querySelector(
      "form[data-board-assign]",
    ) as HTMLFormElement & { requestSubmit: jest.Mock };
    drop(ana, document.querySelector('.kb-board__col[data-group="g_a"]')!);
    expect(form.requestSubmit).not.toHaveBeenCalled();
    const cal = document.querySelector('[data-user="333333333333333333"]')!;
    const calForm = cal.querySelector(
      "form[data-board-assign]",
    ) as HTMLFormElement & { requestSubmit: jest.Mock };
    // Reds holds 2 of 2 in this data: the drop is refused and announced.
    drop(cal, document.querySelector('.kb-board__col[data-group="g_a"]')!);
    expect(calForm.requestSubmit).not.toHaveBeenCalled();
    expect(document.getElementById("host-board-status")!.textContent).toMatch(
      /full/,
    );
  });

  it("opens a toolbar option set in a dialog with Go back, and puts the form back on close", () => {
    setup(renderHostBoard(data()));
    const det = document.getElementById("host-randomise")!;
    const sum = det.querySelector("summary") as HTMLElement;
    const panel = det.querySelector(".kb-toolbar__panel")!;
    sum.click();
    const dlg = document.querySelector("dialog.kb-dialog")!;
    expect(dlg.hasAttribute("open")).toBe(true);
    expect(dlg.contains(panel)).toBe(true);
    expect(dlg.getAttribute("aria-labelledby")).toBe("host-randomise-title");
    expect(dlg.querySelector(".kb-dialog__title")!.textContent).toBe(
      "Randomise people into teams",
    );
    (dlg.querySelector(".kb-btn--ghost") as HTMLElement).click();
    expect(document.querySelector("dialog")).toBeNull();
    expect(det.contains(panel)).toBe(true);
  });
});
