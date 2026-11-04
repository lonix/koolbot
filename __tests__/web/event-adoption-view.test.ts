import { describe, it, expect } from "@jest/globals";
import { renderEventAdoptionPage } from "../../src/web/event-adoption-view.js";
import { info, planned } from "./event-adoption-fixtures.js";

const common = { csrfToken: "tok", remainingMs: 1000, navFeatureStatus: {} };

describe("renderEventAdoptionPage (#1034)", () => {
  it("lists events as checkboxes, disables and explains the ones that can't be adopted, and escapes names", () => {
    const html = renderEventAdoptionPage({
      ...common,
      planned: planned(),
      previewing: false,
    });
    expect(html).toContain('name="ev" value="100" checked');
    expect(html).toMatch(/name="ev" value="200" disabled/);
    expect(html).toContain("Created by KoolBot itself");
    expect(html).toContain("Made by &lt;b&gt;KoolBot&lt;/b&gt;");
    expect(html).not.toContain("<b>KoolBot</b>");
    expect(html).toContain("no temporary voice channel");
    // Preview is a GET with the selection in the query; no apply before it.
    expect(html).toContain('method="GET" action="/admin/adopt/events"');
    expect(html).not.toContain("/admin/adopt/events/apply");
  });

  it("previews the plan and offers apply with the plan id and chosen events", () => {
    const p = planned();
    const html = renderEventAdoptionPage({
      ...common,
      planned: p,
      previewing: true,
    });
    expect(html).toContain("Adopt the Discord event");
    expect(html).toContain('action="/admin/adopt/events/apply"');
    expect(html).toContain(`name="planId" value="${p.plan.id}"`);
    expect(html).toContain('name="ev" value="100"');
    expect(html).toContain('name="_csrf" value="tok"');
    expect(html).toContain("/admin/adopt/history");
  });

  it("offers no apply while the plan is blocked or empty", () => {
    const blocked = planned({}, undefined, ["100"]);
    blocked.plan.errors.push({ code: "events-disabled", message: "off" });
    expect(
      renderEventAdoptionPage({
        ...common,
        planned: blocked,
        previewing: true,
      }),
    ).not.toContain("/admin/adopt/events/apply");
    const empty = planned({}, undefined, []);
    expect(
      renderEventAdoptionPage({ ...common, planned: empty, previewing: true }),
    ).not.toContain("/admin/adopt/events/apply");
  });

  it("shows what is missing: feature off, no announcement channel, no permission", () => {
    const html = renderEventAdoptionPage({
      ...common,
      planned: planned({
        eventsEnabled: false,
        announcementConfigured: false,
        canManageEvents: false,
      }),
      previewing: false,
    });
    expect(html).toContain("The Events feature is off");
    expect(html).toContain("No announcement channel is set");
    expect(html).toContain("lacks the Manage Events permission");
  });

  it("says so when the server has no events", () => {
    const html = renderEventAdoptionPage({
      ...common,
      planned: planned({}, [], []),
      previewing: false,
    });
    expect(html).toContain("no Discord scheduled events");
    expect(html).not.toContain('name="ev"');
  });

  it("renders a failure notice with the message escaped", () => {
    const html = renderEventAdoptionPage({
      ...common,
      planned: null,
      error: "boom <x>",
      previewing: false,
    });
    expect(html).toContain("The server couldn't be read");
    expect(html).toContain("boom &lt;x&gt;");
  });

  it("polls the job when one is running", () => {
    const html = renderEventAdoptionPage({
      ...common,
      planned: planned(),
      previewing: false,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(html).toContain('id="ea-job"');
    expect(html).toContain("/admin/role-groups/job/");
  });
});

/** The page's own markup, without the shared layout around it. */
const mainOf = (html: string): string =>
  html.slice(html.indexOf("<main"), html.indexOf("</main>"));

/** The plan table is renderAdoptionDiff's (#1715), which keeps its own markup. */
const withoutDiff = (html: string): string =>
  html.replace(/<section class="adoption-plan">[\s\S]*?<\/section>/, "");

/** Every class token that is not a kb- class, and every bare table. */
const nonKbClasses = (html: string): string[] => [
  ...[...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((t) => t && !t.startsWith("kb-")),
  ...[...html.matchAll(/<table(?![^>]*class="kb-table")/g)].map((m) => m[0]),
];

describe("event adoption on the kb- components (#1732)", () => {
  const blocked = planned({}, undefined, ["100"]);
  blocked.plan.errors.push({ code: "events-disabled", message: "off" });
  const warned = planned({}, undefined, ["100"]);
  warned.plan.warnings.push({ code: "event-skipped", message: "left out" });
  const none = (over = {}) => planned(over, [], []);
  const render = (p: ReturnType<typeof planned> | null, over = {}) =>
    renderEventAdoptionPage({
      ...common,
      planned: p,
      previewing: false,
      ...over,
    });
  const states: Record<string, string> = {
    list: render(planned()),
    plan: render(planned(), {
      previewing: true,
      flash: { type: "ok", text: "Adopted." },
    }),
    "plan with warnings": render(warned, { previewing: true }),
    blocked: render(blocked, { previewing: true }),
    "nothing chosen": render(planned({}, undefined, []), { previewing: true }),
    empty: render(none()),
    "nothing adoptable": render(
      planned(
        {},
        [
          {
            ...planned().candidates[1].info,
          },
        ],
        [],
      ),
    ),
    "all notices": render(
      planned({
        eventsEnabled: false,
        announcementConfigured: false,
        canManageEvents: false,
      }),
    ),
    job: render(planned(), { jobId: "123e4567-e89b-12d3-a456-426614174000" }),
    unreadable: render(null, { error: "boom <x>" }),
  };

  it.each(Object.keys(states))("%s renders only kb- classes", (name) => {
    expect(nonKbClasses(withoutDiff(mainOf(states[name])))).toEqual([]);
  });

  it.each(Object.keys(states))(
    "%s has one h1 and at most one primary button",
    (name) => {
      const html = mainOf(states[name]);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect((html.match(/kb-btn--primary/g) ?? []).length).toBeLessThanOrEqual(
        1,
      );
    },
  );

  it("leads with the verdict, before the list", () => {
    const html = mainOf(states.list);
    expect(html).toContain("2 of 3 Discord events can be adopted");
    expect(html.indexOf("can be adopted")).toBeLessThan(
      html.indexOf('name="ev"'),
    );
    expect(html).toContain("kb-callout kb-callout--ok");
  });

  it("does not call the verdict fine while events are off or nowhere to announce", () => {
    const off = mainOf(render(planned({ eventsEnabled: false })));
    expect(off).toContain("kb-callout kb-callout--warn");
    expect(off).toContain("applying needs the Events feature on");
    const quiet = mainOf(render(planned({ announcementConfigured: false })));
    expect(quiet).toContain("no announcement post or reminder");
    expect(quiet).not.toContain("kb-callout kb-callout--ok");
  });

  it("says when none of the events can be adopted, and does not offer a preview", () => {
    const html = mainOf(states["nothing adoptable"]);
    expect(html).toContain("None of the 1 Discord events can be adopted");
    expect(html).toContain("Each one says why below");
    expect(html).toMatch(
      /<button type="submit" class="kb-btn" disabled>Preview changes<\/button>/,
    );
    expect(html).toContain("No event can be adopted");
  });

  it("has a primary Preview until a plan can be applied, then Apply is the primary", () => {
    expect(mainOf(states.list)).toMatch(
      /<button type="submit" class="kb-btn kb-btn--primary">Preview changes<\/button>/,
    );
    const plan = mainOf(states.plan);
    expect(plan).toMatch(
      /<button type="submit" class="kb-btn">Preview changes<\/button>/,
    );
    expect(plan).toMatch(
      /<button type="submit" class="kb-btn kb-btn--primary" aria-describedby="ea-apply-help">Apply plan<\/button>/,
    );
  });

  it("keeps the preview form (GET, hidden preview=1) and the checkbox contract", () => {
    const html = states.list;
    expect(html).toContain('method="GET" action="/admin/adopt/events"');
    expect(html).toContain('<input type="hidden" name="preview" value="1">');
    expect(html).toMatch(
      /<input type="checkbox" [^>]*name="ev" value="100" checked/,
    );
    expect(html).toMatch(/<label for="ea-0">/);
    expect(html).not.toContain("/admin/adopt/events/apply");
  });

  it("keeps the apply form, its confirmation and the hidden fields", () => {
    const p = planned();
    const html = render(p, { previewing: true });
    expect(html).toContain(
      '<form method="POST" action="/admin/adopt/events/apply"',
    );
    expect(html).toContain(
      'data-confirm="Adopt these events as KoolBot events? A snapshot is saved first and the Discord events are not changed."',
    );
    expect(html).toContain('data-confirm-tone="neutral"');
    expect(html).toContain('type="hidden" name="_csrf" value="tok"');
    expect(html).toContain(`name="planId" value="${p.plan.id}"`);
    expect(html).toContain('<input type="hidden" name="ev" value="100">');
    expect(html).toContain('href="/admin/adopt/history"');
  });

  it("puts the plan table in a scroll container", () => {
    expect(mainOf(states.plan)).toMatch(
      /<div class="kb-panel__body kb-panel__body--flush"><section class="adoption-plan">/,
    );
  });

  it("a blocked plan says it cannot be applied and does not read as nothing to do", () => {
    const html = mainOf(states.blocked);
    expect(html).toContain("This plan can't be applied yet");
    expect(html).toContain("kb-callout kb-callout--err");
    expect(html).not.toContain("/admin/adopt/events/apply");
    expect(html).not.toContain("Nothing to");
  });

  it("a plan with nothing chosen does not claim the server matches", () => {
    const html = mainOf(states["nothing chosen"]);
    expect(html).toContain("Nothing chosen to adopt");
    expect(html).not.toContain("already matches");
    expect(html).not.toContain("adoption-plan");
    expect(html).not.toContain("/admin/adopt/events/apply");
  });

  it("lists plan warnings when nothing is left to adopt", () => {
    const w = planned({}, undefined, []);
    w.plan.warnings.push({ code: "event-skipped", message: "left out <i>" });
    const html = mainOf(render(w, { previewing: true }));
    expect(html).toContain("left out &lt;i&gt;");
  });

  it("uses the right callout role for each state", () => {
    expect(mainOf(states.unreadable)).toMatch(
      /kb-callout kb-callout--err" role="alert"/,
    );
    expect(mainOf(states["all notices"])).toMatch(
      /kb-callout kb-callout--warn" role="status"/,
    );
    expect(mainOf(states["all notices"])).not.toContain('role="alert"');
  });

  it("keeps the job line the script updates", () => {
    expect(states.job).toMatch(
      /<p class="kb-callout__title" id="ea-job">Applying…<\/p>/,
    );
    expect(states.job).toContain("/admin/role-groups/job/");
  });

  it("shows an empty state, not a bare sentence, when the server has no events", () => {
    const html = mainOf(states.empty);
    expect(html).toContain("kb-empty");
    expect(html).toContain("no Discord scheduled events");
  });

  it("escapes names and the failure message", () => {
    expect(states.list).toContain("Made by &lt;b&gt;KoolBot&lt;/b&gt;");
    expect(states.unreadable).toContain("boom &lt;x&gt;");
  });

  it("announces each event's own start time, even when name and notes match", () => {
    const a = info({ id: "100", startsAt: "2026-10-20T19:00:00.000Z" });
    const b = info({ id: "101", startsAt: "2026-10-27T19:00:00.000Z" });
    const html = mainOf(render(planned({}, [a, b], [])));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const text = (id: string): string =>
      html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1] ?? "";
    for (const [value, date] of [
      ["100", a.startsAt],
      ["101", b.startsAt],
    ]) {
      const described = html.match(
        new RegExp(`aria-describedby="([^"]+)" name="ev" value="${value}"`),
      )?.[1];
      expect(described).toBeDefined();
      const spoken = (described as string).split(" ").map(text).join(" ");
      expect(spoken).toContain(date as string);
    }
  });
});
