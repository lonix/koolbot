/* global Element, Document */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { ChannelType } from "discord.js";
import {
  renderRulesPage,
  type RulesPageProps,
} from "../../src/web/rules-page.js";

/**
 * The Rules page renders only `kb-` classes (#1731, epic #1639): no `card`,
 * `notice`, `tag`, `btn`, `subtitle`, `empty`, `muted`, `check`, `stack`,
 * `kv`, `helper`, `field-row`, bare `<table>` or `<h1>`.
 *
 * The plan diff (`renderAdoptionDiff`, migrated with #1715) is out of the check
 * on purpose: it is cut from the DOM before the class names are read.
 */

const plan = (over: Record<string, unknown> = {}) => ({
  plan: {
    id: "plan-1",
    guildId: "g",
    plannedBy: "a",
    operations: [
      {
        id: "op-1",
        type: "role.create",
        class: "additive",
        summary: "Create role Accepted",
        before: null,
        after: { name: "Accepted", permissions: "0" },
      },
    ],
    warnings: [],
    errors: [],
  },
  extraErrors: [],
  preview: { totalMembers: 10, holders: 2, lockedOut: 1 },
  roleId: "100000000000000011",
  roleName: "Accepted",
  channels: [],
  options: { createRole: false, grantExisting: false, gateChannelIds: [] },
  membersUnavailable: false,
  ...over,
});

const props = (over: Record<string, unknown> = {}): RulesPageProps =>
  ({
    csrfToken: "tok",
    remainingMs: 1000,
    enabled: true,
    channelId: "100000000000000010",
    roleId: "100000000000000011",
    messagePosted: true,
    messageId: "900000000000000003",
    accepted: 12,
    native: { screening: false, community: false },
    intentMissing: false,
    plan: null,
    channels: [
      {
        id: "100000000000000010",
        name: "rules",
        type: ChannelType.GuildText,
      },
      {
        id: "100000000000000012",
        name: "general",
        type: ChannelType.GuildText,
      },
    ],
    roleName: "Accepted",
    unavailable: null,
    options: { createRole: false, grantExisting: false, gateChannelIds: [] },
    jobId: null,
    ...over,
  }) as unknown as RulesPageProps;

const states: Array<[string, string]> = [
  ["status, posted", renderRulesPage(props())],
  [
    "status, off",
    renderRulesPage(
      props({
        enabled: false,
        channelId: "",
        roleId: "",
        messagePosted: false,
      }),
    ),
  ],
  [
    "status, no channel",
    renderRulesPage(props({ channelId: "", messagePosted: false })),
  ],
  [
    "status, not posted, no role",
    renderRulesPage(props({ roleId: "", messagePosted: false })),
  ],
  [
    "notices",
    renderRulesPage(
      props({
        native: { screening: true, community: true },
        intentMissing: true,
        unavailable: "The server couldn't be read from Discord.",
      }),
    ),
  ],
  [
    "community notice",
    renderRulesPage(props({ native: { screening: false, community: true } })),
  ],
  [
    "rollout form, ticked",
    renderRulesPage(
      props({
        roleId: "",
        options: {
          createRole: true,
          grantExisting: true,
          gateChannelIds: ["100000000000000012"],
        },
      }),
    ),
  ],
  ["rollout form, no channels", renderRulesPage(props({ channels: [] }))],
  ["plan, applicable", renderRulesPage(props({ plan: plan() }))],
  [
    "plan, blocked",
    renderRulesPage(
      props({
        plan: plan({
          extraErrors: [{ code: "admin-lockout", message: "Your own access" }],
        }),
      }),
    ),
  ],
  [
    "plan, nothing to change",
    renderRulesPage(
      props({
        plan: plan({
          plan: {
            id: "p",
            guildId: "g",
            plannedBy: "a",
            operations: [],
            warnings: [],
            errors: [],
          },
          preview: { totalMembers: null, holders: null, lockedOut: null },
        }),
      }),
    ),
  ],
  ["apply running", renderRulesPage(props({ jobId: "job-1" }))],
  ["flash", renderRulesPage(props({ flash: { type: "ok", text: "Posted." } }))],
];

/** The page's own content as a DOM: `<main>` without the shared plan diff. */
function content(html: string): Element {
  const main = new JSDOM(html).window.document.querySelector("main");
  if (!main) throw new Error("page has no <main>");
  main.querySelectorAll("section.adoption-plan").forEach((e) => e.remove());
  return main;
}

const classTokens = (root: Element): string[] =>
  [...root.querySelectorAll("[class]")].flatMap((e) =>
    [...e.classList].filter(Boolean),
  );

describe.each(states)("Rules page: %s", (_name, html) => {
  const body = content(html);

  it("renders content", () => {
    expect(body.textContent?.length ?? 0).toBeGreaterThan(50);
  });

  it("uses only kb- classes", () => {
    const old = classTokens(body).filter((t) => !t.startsWith("kb-"));
    expect([...new Set(old)]).toEqual([]);
  });

  it("has no bare table, unstyled heading or inline style", () => {
    const bad = (sel: string): number => body.querySelectorAll(sel).length;
    expect(bad("table:not(.kb-table)")).toBe(0);
    expect(bad("h1, h2, h3")).toBe(bad('[class^="kb-"]:is(h1, h2, h3)'));
    expect(bad("[style]")).toBe(0);
  });

  it("has one h1 and at most one primary button", () => {
    expect(body.querySelectorAll("h1").length).toBe(1);
    expect(
      body.querySelectorAll(".kb-btn--primary").length,
    ).toBeLessThanOrEqual(1);
  });
});

describe("Rules page behaviour kept through the migration", () => {
  const doc = (html: string): Document => new JSDOM(html).window.document;

  it("leads with the verdict, then the problems, then the Status panel", () => {
    const html = renderRulesPage(
      props({ intentMissing: true, messagePosted: false }),
    );
    const verdict = html.indexOf("The rules message is not posted yet.");
    const problem = html.indexOf("The Server Members intent is off");
    const status = html.indexOf('id="rules-status"');
    expect(verdict).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(problem);
    expect(problem).toBeLessThan(status);
  });

  it("says the rules message is posted, with the count and the rollout state", () => {
    const text = doc(renderRulesPage(props())).querySelector(
      ".kb-callout--ok",
    )?.textContent;
    expect(text).toContain("The rules message is posted.");
    expect(text).toContain("12 acceptances recorded.");
    expect(text).toContain("No rollout is previewed.");
  });

  it("keeps the apply job's id on the Callout title, which the poller rewrites", () => {
    expect(renderRulesPage(props({ jobId: "job-1" }))).toContain(
      '<p class="kb-callout__title" id="rules-job">Applying…</p>',
    );
  });

  it("posts the same forms with the same confirmations", () => {
    const d = doc(renderRulesPage(props({ plan: plan() })));
    const post = d.querySelector('form[action="/admin/rules/post"]')!;
    expect(post.getAttribute("method")).toBe("POST");
    expect(post.getAttribute("data-confirm")).toBeNull();
    expect(post.querySelector('input[name="_csrf"]')).not.toBeNull();
    const sync = d.querySelector('form[action="/admin/rules/sync"]')!;
    expect(sync.getAttribute("data-confirm")).toMatch(/^Record everyone/);
    const apply = d.querySelector('form[action="/admin/rules/apply"]')!;
    expect(apply.getAttribute("data-confirm")).toMatch(/^Apply this plan/);
    expect(
      apply.querySelector('input[name="planId"]')?.getAttribute("value"),
    ).toBe("plan-1");
    // Apply plan is the view's one primary, so Post is neutral.
    expect(post.querySelector("button")?.className).toBe("kb-btn");
    expect(apply.querySelector("button")?.className).toContain(
      "kb-btn--primary",
    );
  });

  it("makes Post the primary while no plan can be applied", () => {
    const d = doc(renderRulesPage(props()));
    expect(
      d.querySelector('form[action="/admin/rules/post"] button')?.className,
    ).toContain("kb-btn--primary");
  });

  it("keeps the rollout form a GET with the same field names and values", () => {
    const d = doc(
      renderRulesPage(
        props({
          roleId: "",
          options: {
            createRole: true,
            grantExisting: true,
            gateChannelIds: ["100000000000000012"],
          },
        }),
      ),
    );
    const form = d.querySelector('form[action="/admin/rules"]')!;
    expect(form.getAttribute("method")).toBe("GET");
    expect(
      form.querySelector('input[name="preview"]')?.getAttribute("value"),
    ).toBe("1");
    for (const name of ["createRole", "grantExisting"]) {
      const box = form.querySelector(`input[name="${name}"]`)!;
      expect(box.getAttribute("type")).toBe("checkbox");
      expect(box.getAttribute("value")).toBe("1");
      expect(box.hasAttribute("checked")).toBe(true);
    }
    const gates = [...form.querySelectorAll('input[name="gate"]')];
    expect(gates.map((g) => g.getAttribute("value"))).toEqual([
      "100000000000000010",
      "100000000000000012",
    ]);
    expect(gates.map((g) => g.hasAttribute("checked"))).toEqual([false, true]);
  });

  it("offers no role creation once a role is set", () => {
    const d = doc(renderRulesPage(props()));
    expect(d.querySelector('input[name="createRole"]')).toBeNull();
  });

  it("carries the previewed options into the apply form as hidden fields", () => {
    const d = doc(
      renderRulesPage(
        props({
          options: {
            createRole: true,
            grantExisting: true,
            gateChannelIds: ["100000000000000012"],
          },
          plan: plan(),
        }),
      ),
    );
    const apply = d.querySelector('form[action="/admin/rules/apply"]')!;
    expect(apply.querySelector('input[name="createRole"]')).not.toBeNull();
    expect(apply.querySelector('input[name="grantExisting"]')).not.toBeNull();
    expect(
      apply.querySelector('input[name="gate"]')?.getAttribute("value"),
    ).toBe("100000000000000012");
  });

  it("says why a button is off, next to it", () => {
    const off = doc(
      renderRulesPage(
        props({ enabled: false, roleId: "", messagePosted: false }),
      ),
    );
    expect(
      off
        .querySelector('form[action="/admin/rules/post"] button')
        ?.hasAttribute("disabled"),
    ).toBe(true);
    expect(off.getElementById("rules-status")?.textContent).toContain(
      "Turn on Rules acceptance in Settings first.",
    );
    expect(off.getElementById("rules-status")?.textContent).toContain(
      "Set the acceptance role in Settings first.",
    );
  });

  it("shows a Callout instead of the Preview's apply form when nothing can be applied", () => {
    const html = renderRulesPage(
      props({
        plan: plan({
          extraErrors: [{ code: "admin-lockout", message: "Your own access" }],
        }),
      }),
    );
    expect(html).not.toContain('action="/admin/rules/apply"');
    expect(html).toContain("Needs attention (1)");
  });

  it("says a blocked rollout with pending operations can't be applied, not that there is nothing to apply", () => {
    for (const blocked of [
      plan({ extraErrors: [{ code: "admin-lockout", message: "Own access" }] }),
      plan({
        plan: {
          ...plan().plan,
          errors: [{ code: "x", message: "Blocked" }],
        },
      }),
    ]) {
      const html = renderRulesPage(props({ plan: blocked }));
      const text = doc(html).querySelector(".kb-callout")?.textContent ?? "";
      expect(text).toContain("can't be applied until the listed problems");
      expect(text).not.toContain("nothing to apply");
      expect(html).not.toContain('action="/admin/rules/apply"');
    }
  });

  it("says there is nothing to apply only for an empty plan", () => {
    const empty = plan({
      plan: { ...plan().plan, operations: [] },
      preview: { totalMembers: null, holders: null, lockedOut: null },
    });
    const text = doc(renderRulesPage(props({ plan: empty }))).querySelector(
      ".kb-callout",
    )?.textContent;
    expect(text).toContain("there is nothing to apply");
  });

  it("keeps the record-holders button label short and explains it in a help line", () => {
    const d = doc(renderRulesPage(props()));
    const btn = d.querySelector('form[action="/admin/rules/sync"] button')!;
    expect(btn.textContent).toBe("Record current role holders");
    expect(btn.getAttribute("aria-describedby")).toBe("rules-sync-help");
    expect(d.getElementById("rules-sync-help")?.textContent).toContain(
      "as accepted",
    );
    expect(
      d
        .querySelector('form[action="/admin/rules/sync"]')
        ?.getAttribute("data-confirm"),
    ).toMatch(/^Record everyone who already holds the acceptance role/);
  });

  it("puts the plan diff in a scrolling flush body so a wide table does not widen the page", () => {
    const d = doc(renderRulesPage(props({ plan: plan() })));
    const diff = d.querySelector("section.adoption-plan")!;
    expect(
      diff.closest("#rules-preview .kb-panel__body--flush"),
    ).not.toBeNull();
  });
});
