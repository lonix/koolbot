import { describe, it, expect } from "@jest/globals";
import {
  renderAssignmentSection,
  type AssignmentViewData,
} from "../../src/web/host-assignment-view.js";
import { GROUP_MEMBER_MAX } from "../../src/services/event-group-plan.js";

const data = (over: Partial<AssignmentViewData>): AssignmentViewData => ({
  csrfToken: "t",
  actionPath: (n) => `/x/${n}`,
  groupLabel: "Team",
  locked: false,
  presenceOk: true,
  groups: [],
  people: [],
  ...over,
});

const option = (html: string, key: string): string =>
  html.match(new RegExp(`<option value="${key}"[^>]*>[^<]*</option>`))?.[0] ??
  "";

describe("assignment section options", () => {
  const groups = [
    {
      key: "g_full",
      name: "Big",
      marker: "",
      size: null,
      memberCount: GROUP_MEMBER_MAX,
      isTeam: true,
    },
    {
      key: "g_sized",
      name: "Small",
      marker: "",
      size: 2,
      memberCount: 2,
      isTeam: true,
    },
    {
      key: "g_room",
      name: "Room",
      marker: "",
      size: null,
      memberCount: 3,
      isTeam: true,
    },
  ];

  it("disables and labels an unsized group that has reached the member maximum", () => {
    const html = renderAssignmentSection(
      data({
        groups,
        people: [{ id: "1", name: "Ana", connected: true, groupKey: null }],
      }),
    );
    expect(option(html, "g_full")).toMatch(/disabled/);
    expect(option(html, "g_full")).toContain(`${GROUP_MEMBER_MAX}, full`);
    expect(option(html, "g_sized")).toMatch(/disabled/);
    expect(option(html, "g_room")).not.toMatch(/disabled/);
  });

  it("keeps a full group selectable for its own member", () => {
    const html = renderAssignmentSection(
      data({
        groups,
        people: [{ id: "1", name: "Ana", connected: true, groupKey: "g_full" }],
      }),
    );
    expect(option(html, "g_full")).not.toMatch(/disabled/);
    expect(option(html, "g_full")).toMatch(/selected/);
  });
});
