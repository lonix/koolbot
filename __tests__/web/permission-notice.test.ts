/**
 * The per-feature permission notice (#1253), from literal reports: no Discord,
 * no settings. Permissions present and absent, enabled and disabled, the check
 * unavailable, and the recorded warnings the host panel already shows.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { Client } from "discord.js";
import type {
  BotPermissionReport,
  CheckOutcome,
  FeatureCheck,
  PermissionTarget,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  HOST_ACCESS_WARNING,
  LEADS_MANAGE_ROLES_WARNING,
  MANAGE_CHANNELS_CREATE_WARNING,
  RECORDED_WARNINGS,
} from "../../src/services/bot-permission-registry.js";
import {
  buildPermissionNotice,
  inAreas,
  inFeatures,
  loadPermissionNotice,
  renderPermissionNotice,
} from "../../src/web/permission-notice.js";

const cat = (name: string): PermissionTarget => ({
  kind: "category",
  id: `cat-${name}`,
  name,
});

function featureRef(id: string): FeatureCheck["feature"] {
  const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(`no registry entry ${id}`);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

function check(
  id: string,
  outcome: CheckOutcome,
  target: PermissionTarget | null,
  o: { enabled?: boolean; missing?: string[] } = {},
): FeatureCheck {
  return {
    feature: featureRef(id),
    kind: "permission",
    enabled: o.enabled ?? true,
    outcome,
    target,
    missing: o.missing ?? [],
  };
}

function report(
  checks: FeatureCheck[],
  o: Partial<BotPermissionReport> = {},
): BotPermissionReport {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks,
    ...o,
  };
}

const EVENTS = { enabled: true, filter: inAreas("Events") };
const OPTS = { canLinkToPage: true };

describe("buildPermissionNotice", () => {
  it("says nothing when the permissions are in place", () => {
    const r = report([
      check("event-channels", "ok", cat("Events")),
      check("event-tags", "ok", {
        kind: "server",
        id: null,
        name: "the server",
      }),
    ]);
    expect(buildPermissionNotice(r, EVENTS)).toBeNull();
  });

  it("names the permission and the category when one is missing", () => {
    const r = report([
      check("event-channels", "missing", cat("Events"), {
        missing: ["Manage Channels"],
      }),
    ]);
    const n = buildPermissionNotice(r, EVENTS);
    expect(n?.missing).toHaveLength(1);
    const html = renderPermissionNotice(n, OPTS);
    expect(html).toContain("Manage Channels");
    expect(html).toContain("in the category “Events”");
    expect(html).toContain("Event and group channels");
    // The registry's own effect text, not a copy.
    expect(html).toContain("are not created, deleted or put in order");
    expect(html).toContain('href="/admin/bot-permissions"');
    expect(html).toContain("kb-callout--warn");
    expect(html).not.toContain('role="alert"');
  });

  it("says server-wide for a permission a channel cannot grant", () => {
    const r = report([
      check(
        "event-tags",
        "missing",
        { kind: "server", id: null, name: "the server" },
        { missing: ["Manage Nicknames"] },
      ),
    ]);
    expect(
      renderPermissionNotice(buildPermissionNotice(r, EVENTS), OPTS),
    ).toContain("Manage Nicknames</strong> server-wide");
  });

  it("leaves out a feature that is switched off", () => {
    const r = report([
      check("event-channels", "missing", cat("Events"), {
        enabled: false,
        missing: ["Manage Channels"],
      }),
    ]);
    expect(buildPermissionNotice(r, EVENTS)).toBeNull();
  });

  it("leaves out another area and a feature with no channel set", () => {
    const r = report([
      check("voice-rooms", "missing", cat("Voice"), {
        missing: ["Manage Channels"],
      }),
      check("event-channels", "unchecked", null),
    ]);
    expect(buildPermissionNotice(r, EVENTS)).toBeNull();
  });

  it("selects by feature id", () => {
    const r = report([
      check("event-channels", "missing", cat("Events"), {
        missing: ["Manage Channels"],
      }),
      check("event-moves", "missing", cat("Events"), {
        missing: ["Move Members"],
      }),
    ]);
    const n = buildPermissionNotice(r, {
      enabled: true,
      filter: inFeatures("event-moves"),
    });
    expect(n?.missing.map((m) => m.feature.id)).toEqual(["event-moves"]);
  });

  it("says a feature could not be checked, with the checker's reason", () => {
    const target = { kind: "category" as const, id: "gone", name: "gone" };
    const r = report([check("event-channels", "unknown", target)], {
      unknown: [
        {
          feature: featureRef("event-channels"),
          target,
          note: "The configured category could not be found.",
        },
      ],
    });
    const html = renderPermissionNotice(buildPermissionNotice(r, EVENTS), OPTS);
    expect(html).toContain("could not be checked");
    expect(html).toContain("The configured category could not be found.");
    expect(html).not.toContain("kb-callout--warn");
  });

  it("says so when the check cannot run at all, never that all is well", () => {
    const r = report([], {
      available: false,
      reason: "The bot could not read this server from Discord.",
    });
    const n = buildPermissionNotice(r, EVENTS);
    const html = renderPermissionNotice(n, OPTS);
    expect(html).toContain("could not be checked");
    expect(html).toContain("The bot could not read this server from Discord.");
    expect(html).toContain(
      "cannot tell you whether the bot has what this feature needs",
    );
  });

  it("stays quiet about an unavailable check while the feature is off", () => {
    const r = report([], { available: false, reason: "x" });
    expect(buildPermissionNotice(r, { ...EVENTS, enabled: false })).toBeNull();
  });

  it("flags a stale read when something is shown", () => {
    const r = report(
      [
        check("event-channels", "missing", cat("Events"), {
          missing: ["Manage Channels"],
        }),
      ],
      { fresh: false },
    );
    expect(
      renderPermissionNotice(buildPermissionNotice(r, EVENTS), OPTS),
    ).toContain("may be out of date");
    // Stale and fine: still nothing to say.
    const fine = report([check("event-channels", "ok", cat("Events"))], {
      fresh: false,
    });
    expect(buildPermissionNotice(fine, EVENTS)).toBeNull();
  });

  it("escapes names, permissions and reasons", () => {
    const evil = cat('<img src=x onerror="alert(1)">');
    const r = report([
      check("event-channels", "missing", evil, { missing: ["<b>x</b>"] }),
      check("event-moves", "unknown", evil),
    ]);
    const html = renderPermissionNotice(buildPermissionNotice(r, EVENTS), OPTS);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
  });

  it("gives a host who is not an admin a sentence, not a link", () => {
    const r = report([
      check("event-channels", "missing", cat("Events"), {
        missing: ["Manage Channels"],
      }),
    ]);
    const html = renderPermissionNotice(buildPermissionNotice(r, EVENTS), {
      canLinkToPage: false,
    });
    expect(html).not.toContain("/admin/bot-permissions");
    expect(html).toContain("Ask a server admin");
  });

  it("renders nothing for null", () => {
    expect(renderPermissionNotice(null, OPTS)).toBe("");
  });
});

describe("recorded warnings the page already shows", () => {
  it("only names registry entries, and permissions those entries need", () => {
    for (const [id, w] of Object.entries(RECORDED_WARNINGS)) {
      const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
      expect(r).toBeDefined();
      const needed = r?.needs.map((n) => n.name) ?? [];
      for (const c of w.covers) expect(needed).toContain(c);
      expect(w.texts.length).toBeGreaterThan(0);
    }
  });

  const missingChannels = check("event-channels", "missing", cat("Events"), {
    missing: ["Manage Channels"],
  });

  it("drops a finding its recorded warning fully covers", () => {
    const n = buildPermissionNotice(report([missingChannels]), {
      ...EVENTS,
      shownWarnings: [MANAGE_CHANNELS_CREATE_WARNING],
    });
    expect(n).toBeNull();
  });

  it("keeps it when the recorded warning is not on the page", () => {
    const n = buildPermissionNotice(report([missingChannels]), EVENTS);
    expect(n?.missing).toHaveLength(1);
  });

  it("keeps what the recorded warning does not name", () => {
    // The leaders-only warning covers Manage Roles only.
    const r = report([
      check("event-leads-channel", "missing", cat("Events"), {
        missing: ["Manage Roles", "Move Members"],
      }),
    ]);
    const n = buildPermissionNotice(r, {
      ...EVENTS,
      shownWarnings: [LEADS_MANAGE_ROLES_WARNING],
    });
    expect(n?.missing).toHaveLength(1);
    // Fully covered, it goes.
    const only = report([
      check("event-leads-channel", "missing", cat("Events"), {
        missing: ["Manage Roles"],
      }),
    ]);
    expect(
      buildPermissionNotice(only, {
        ...EVENTS,
        shownWarnings: [LEADS_MANAGE_ROLES_WARNING],
      }),
    ).toBeNull();
  });

  it("host access: both permissions are covered by its warning", () => {
    const r = report([
      check("event-host-access", "missing", cat("Events"), {
        missing: ["Manage Roles", "Move Members"],
      }),
    ]);
    expect(
      buildPermissionNotice(r, {
        ...EVENTS,
        shownWarnings: [HOST_ACCESS_WARNING],
      }),
    ).toBeNull();
  });
});

describe("loadPermissionNotice", () => {
  const client = {} as Client;

  it("does not run the check while the feature is off", async () => {
    const check = jest.fn<() => Promise<BotPermissionReport>>();
    const n = await loadPermissionNotice({
      ...EVENTS,
      enabled: false,
      client,
      guildId: "g",
      check,
    });
    expect(n).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("builds the notice from the checker's report", async () => {
    const n = await loadPermissionNotice({
      ...EVENTS,
      client,
      guildId: "g",
      check: async () =>
        report([
          check("event-channels", "missing", cat("Events"), {
            missing: ["Manage Channels"],
          }),
        ]),
    });
    expect(n?.missing).toHaveLength(1);
  });

  it("says the check could not run when the checker throws", async () => {
    const n = await loadPermissionNotice({
      ...EVENTS,
      client,
      guildId: "g",
      check: async () => {
        throw new Error("boom");
      },
    });
    expect(n?.unavailable).toContain("could not be checked");
  });

  it("does not hold the page past the timeout", async () => {
    const n = await loadPermissionNotice({
      ...EVENTS,
      client,
      guildId: "g",
      timeoutMs: 5,
      check: () => new Promise<BotPermissionReport>(() => undefined),
    });
    expect(n?.unavailable).toContain("did not finish in time");
  });
});
