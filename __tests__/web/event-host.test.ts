/**
 * The host access rule (#1189) and the small helpers around it.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  hostControlsAvailable,
  hostPanelPath,
  isEventHost,
  listHostedEvents,
} from "../../src/web/event-host.js";
import { Event } from "../../src/models/event.js";
import {
  HOST_SECTIONS,
  renderHostPanelBody,
  type HostPanelEvent,
} from "../../src/web/host-panel-view.js";

const GUILD = "g1";
const session = (over: Record<string, unknown> = {}) =>
  ({ discordUserId: "u1", guildId: GUILD, role: "user", ...over }) as never;
const event = (over: Record<string, unknown> = {}) =>
  ({ guildId: GUILD, createdBy: "u1", state: "scheduled", ...over }) as never;

describe("isEventHost", () => {
  it("is true for the creator", () => {
    expect(isEventHost(session(), event(), GUILD)).toBe(true);
  });

  it("is true for an admin session on someone else's event", () => {
    expect(
      isEventHost(
        session({ role: "admin", discordUserId: "boss" }),
        event(),
        GUILD,
      ),
    ).toBe(true);
  });

  it("is false for another member", () => {
    expect(isEventHost(session({ discordUserId: "u2" }), event(), GUILD)).toBe(
      false,
    );
  });

  it("is false when the event is in another guild, even for the creator or an admin", () => {
    const foreign = event({ guildId: "g2" });
    expect(isEventHost(session(), foreign, GUILD)).toBe(false);
    expect(isEventHost(session({ role: "admin" }), foreign, GUILD)).toBe(false);
  });

  it("is false when the session guild is not the configured guild", () => {
    expect(
      isEventHost(
        session({ guildId: "g2", role: "admin" }),
        event({ guildId: "g2" }),
        GUILD,
      ),
    ).toBe(false);
  });

  it("still requires the session's own guild when GUILD_ID is unset", () => {
    const foreign = event({ guildId: "g2" });
    expect(isEventHost(session(), foreign, undefined)).toBe(false);
    expect(isEventHost(session({ role: "admin" }), foreign, undefined)).toBe(
      false,
    );
    expect(isEventHost(session(), event(), undefined)).toBe(true);
  });

  it("never matches an empty id", () => {
    expect(
      isEventHost(
        session({ discordUserId: "" }),
        event({ createdBy: "" }),
        GUILD,
      ),
    ).toBe(false);
    expect(isEventHost(session(), event({ createdBy: "" }), GUILD)).toBe(false);
    expect(isEventHost(session(), event({ createdBy: null }), GUILD)).toBe(
      false,
    );
    expect(isEventHost(session({ guildId: "" }), event(), GUILD)).toBe(false);
  });

  it("fails closed on missing input and on an unknown role", () => {
    expect(isEventHost(null, event(), GUILD)).toBe(false);
    expect(isEventHost(session(), null, GUILD)).toBe(false);
    expect(isEventHost(undefined, undefined, GUILD)).toBe(false);
    expect(isEventHost(session({ role: "root" }), event(), GUILD)).toBe(false);
  });

  it("compares ids exactly, with no trimming or case folding", () => {
    expect(isEventHost(session(), event({ createdBy: "U1" }), GUILD)).toBe(
      false,
    );
    expect(isEventHost(session(), event({ createdBy: " u1" }), GUILD)).toBe(
      false,
    );
  });

  it("refuses discarded cleanup-only rows for everyone", () => {
    const row = event({ nativeCleanupOnly: true });
    expect(isEventHost(session(), row, GUILD)).toBe(false);
    expect(isEventHost(session({ role: "admin" }), row, GUILD)).toBe(false);
  });
});

describe("hostControlsAvailable", () => {
  it("is true only for scheduled and active events", () => {
    expect(hostControlsAvailable({ state: "scheduled" })).toBe(true);
    expect(hostControlsAvailable({ state: "active" })).toBe(true);
    expect(hostControlsAvailable({ state: "ended" })).toBe(false);
    expect(hostControlsAvailable({ state: "cancelled" })).toBe(false);
    expect(hostControlsAvailable(null)).toBe(false);
  });
});

describe("hostPanelPath", () => {
  it("is the stable base for later controls and encodes the id", () => {
    expect(hostPanelPath("abc")).toBe("/me/events/abc/host");
    expect(hostPanelPath("a/b")).toBe("/me/events/a%2Fb/host");
  });
});

describe("listHostedEvents", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns nothing without querying when an id is empty", async () => {
    const spy = jest.spyOn(Event, "find");
    expect(await listHostedEvents("", "u1")).toEqual([]);
    expect(await listHostedEvents(GUILD, "")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks only for this member's open, non-adopted, non-cleanup events and caps the list", async () => {
    const limit = jest.fn(() => ({ lean: async () => [] }));
    jest.spyOn(Event, "find").mockReturnValue({
      sort: () => ({ limit }),
    } as never);
    await listHostedEvents(GUILD, "u1");
    expect(Event.find).toHaveBeenCalledWith({
      guildId: GUILD,
      createdBy: "u1",
      state: { $in: ["scheduled", "active"] },
      nativeCleanupOnly: { $ne: true },
      nativeAdopted: { $ne: true },
    });
    expect(limit).toHaveBeenCalledWith(10);
  });

  it("returns an empty list when the read fails", async () => {
    jest.spyOn(Event, "find").mockImplementation(() => {
      throw new Error("down");
    });
    expect(await listHostedEvents(GUILD, "u1")).toEqual([]);
  });
});

describe("renderHostPanelBody", () => {
  const base: HostPanelEvent = {
    id: "1",
    title: "T",
    description: "",
    state: "scheduled",
    when: "2030-01-01 19:00 (UTC)",
    durationMinutes: 60,
    recurrence: null,
    channel: null,
    groupsEnabled: true,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    groups: [],
    adopted: false,
  };

  it("lets a later issue replace a section body without touching the page", () => {
    const html = renderHostPanelBody({
      event: base,
      controls: { moves: "<p>MOVE CONTROLS</p>" },
    });
    expect(html).toContain("MOVE CONTROLS");
    expect(html).toContain('id="host-assignment"');
    expect(html).toContain("Not available yet");
  });

  it("offers one section per definition when groups are on (leaders only while switched on)", () => {
    const html = renderHostPanelBody({ event: base });
    for (const s of HOST_SECTIONS.filter((d) => !d.needsLeaders)) {
      expect(html).toContain(`id="host-${s.id}"`);
    }
    expect(html).not.toContain('id="host-leaders"');
    const withLeaders = renderHostPanelBody({
      event: { ...base, captainsEnabled: true },
    });
    for (const s of HOST_SECTIONS) {
      expect(withLeaders).toContain(`id="host-${s.id}"`);
    }
  });

  it("lists group channel problems as a warning, escaped, and nothing when there are none", () => {
    const group = {
      name: "A",
      marker: "",
      kind: "team" as const,
      size: null,
      tag: "",
      hasChannel: false,
      memberCount: 0,
      fill: "0",
    };
    const withNotices = renderHostPanelBody({
      event: {
        ...base,
        groups: [group],
        groupNotices: ["No <b>permission</b>"],
      },
    });
    expect(withNotices).toContain("No &lt;b&gt;permission&lt;/b&gt;");
    expect(withNotices).not.toContain("<b>permission</b>");
    const none = renderHostPanelBody({
      event: { ...base, groups: [group] },
    });
    expect(none).not.toContain("could not be set up");
  });

  it("shows how full each team group is, and n/a for groups that take no members", () => {
    const html = renderHostPanelBody({
      event: {
        ...base,
        groups: [
          {
            ...base.groups[0],
            kind: "team",
            size: 2,
            memberCount: 2,
            fill: "2/2",
          },
          {
            ...base.groups[0],
            name: "Free",
            kind: "team",
            size: null,
            memberCount: 5,
            fill: "5",
          },
          {
            ...base.groups[0],
            name: "Watch",
            kind: "open",
            size: null,
            memberCount: 0,
            fill: "0",
          },
        ],
      },
    });
    expect(html).toContain('<span class="mono">2/2</span>');
    expect(html).toContain('<span class="mono">5</span>');
    expect(html).toContain('<span class="muted">n/a</span>');
  });

  it("escapes every rendered value", () => {
    const html = renderHostPanelBody({
      event: {
        ...base,
        title: "<script>1</script>",
        description: "<img src=x>",
        channel: "<c>",
        recurrence: "<r>",
        groups: [
          {
            name: "<n>",
            marker: "<m>",
            kind: "team",
            size: null,
            tag: "<t>",
            hasChannel: false,
            memberCount: 0,
            fill: "0",
          },
        ],
      },
    });
    expect(html).not.toMatch(/<script>1|<img src=x|<c>|<r>|<n>|<m>|<t>/);
  });
});
