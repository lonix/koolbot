import { describe, it, expect } from "@jest/globals";
import { renderEventAdoptionPage } from "../../src/web/event-adoption-view.js";
import { planned } from "./event-adoption-fixtures.js";

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
