/**
 * The permission matrix and the "How to fix" steps (#1306), rolled up from a
 * report's `checks` and `problems` (literal reports: no Discord, no settings).
 */

import { describe, it, expect } from "@jest/globals";
import {
  ROLE_ABOVE_BOT,
  type BotPermissionReport,
  type CheckOutcome,
  type FeatureCheck,
  type PermissionTarget,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  ROLE_HIERARCHY_REQUIREMENTS,
} from "../../src/services/bot-permission-registry.js";
import {
  buildMatrix,
  fixSteps,
  renderBotPermissionsPage,
  ROLE_POSITION_LABEL,
} from "../../src/web/bot-permissions-view.js";

const SERVER: PermissionTarget = {
  kind: "server",
  id: null,
  name: "the server",
};
const cat = (name: string): PermissionTarget => ({
  kind: "category",
  id: `cat-${name}`,
  name,
});

function feature(id: string): FeatureCheck["feature"] {
  const r =
    FEATURE_REQUIREMENTS.find((x) => x.id === id) ??
    ROLE_HIERARCHY_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(`no registry entry ${id}`);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

function permCheck(
  id: string,
  outcome: CheckOutcome,
  target: PermissionTarget | null,
  o: { enabled?: boolean; missing?: string[] } = {},
): FeatureCheck {
  return {
    feature: feature(id),
    kind: "permission",
    enabled: o.enabled ?? true,
    outcome,
    target,
    missing: o.missing ?? [],
  };
}

function report(
  checks: FeatureCheck[],
  extra: Partial<BotPermissionReport> = {},
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
    ...extra,
  };
}

const summary = (rows: ReturnType<typeof buildMatrix>): string[] =>
  rows.map((r) => `${r.label}|${r.status}`);

describe("buildMatrix", () => {
  it("sorts Missing, Not checked, Has, Not needed, and Discord's order inside each group", () => {
    const rows = buildMatrix(
      report([
        // Has: Manage Channels (event-channels). Missing: Manage Nicknames.
        permCheck("event-channels", "ok", cat("Events")),
        permCheck("event-tags", "missing", SERVER, {
          missing: ["Manage Nicknames"],
        }),
        // Not checked: View Channel is not in the registry for these, so use voice rooms.
        permCheck("voice-rooms", "unknown", cat("Voice")),
        // Switched off: Manage Roles
        permCheck("reaction-roles", "ok", SERVER, { enabled: false }),
      ]),
    );
    expect(summary(rows)).toEqual([
      "Manage Nicknames|missing",
      "Manage Channels|unknown",
      "Connect|unknown",
      "Move Members|unknown",
      "Manage Channels|has",
      "Manage Roles|off",
    ]);
  });

  it("puts the Role position row after the permissions of its group", () => {
    const rows = buildMatrix(
      report([
        permCheck("event-tags", "ok", SERVER),
        {
          feature: feature("rules-role-hierarchy"),
          kind: "role-position",
          enabled: true,
          outcome: "ok",
          target: { kind: "role", id: "r", name: "Fans" },
          missing: [],
        },
      ]),
    );
    expect(summary(rows)).toEqual([
      "Manage Nicknames|has",
      `${ROLE_POSITION_LABEL}|has`,
    ]);
  });

  it("splits one permission into rows where the places differ, and keeps the greyed features on the first", () => {
    const lobby: PermissionTarget = { kind: "channel", id: "l", name: "Lobby" };
    const rows = buildMatrix(
      report([
        permCheck("voice-lobby", "missing", lobby, {
          missing: ["Move Members"],
        }),
        permCheck("event-host-access", "ok", cat("Events")),
        permCheck("event-moves", "ok", cat("Events")),
        permCheck("voice-rooms", "ok", cat("Voice"), { enabled: false }),
      ]),
    );
    const move = rows.filter((r) => r.label === "Move Members");
    expect(move.map((r) => r.status)).toEqual(["missing", "has"]);
    expect(move[0].places).toEqual([lobby]);
    expect(move[0].features.map((f) => f.id)).toEqual(["voice-lobby"]);
    expect(move[0].offFeatures.map((f) => f.id)).toEqual(["voice-rooms"]);
    expect(move[1].places).toEqual([cat("Events")]);
    expect(move[1].features.map((f) => f.id).sort()).toEqual([
      "event-host-access",
      "event-moves",
    ]);
    expect(move[1].offFeatures).toEqual([]);
  });

  it("shows a held permission as Has when only another need of the same feature is missing", () => {
    const rows = buildMatrix(
      report([
        permCheck("event-moves", "missing", cat("Events"), {
          missing: ["Connect"],
        }),
      ]),
    );
    expect(summary(rows)).toEqual(["Connect|missing", "Move Members|has"]);
  });

  it("makes 'Create Events or Manage Events' one row, named as the check names it", () => {
    const either = "Create Events or Manage Events";
    expect(
      summary(buildMatrix(report([permCheck("event-native", "ok", SERVER)]))),
    ).toEqual([`${either}|has`]);
    expect(
      summary(
        buildMatrix(
          report([
            permCheck("event-native", "missing", SERVER, { missing: [either] }),
          ]),
        ),
      ),
    ).toEqual([`${either}|missing`]);
  });

  it("treats an enabled feature with no channel set as Not checked, never Has or Not needed", () => {
    const rows = buildMatrix(
      report([permCheck("event-channels", "unchecked", null)]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "unknown", places: [null] });
  });

  it("skips a check whose id the registry does not know instead of failing", () => {
    const stray: FeatureCheck = {
      ...permCheck("event-tags", "ok", SERVER),
      feature: { ...feature("event-tags"), id: "removed-from-registry" },
    };
    expect(buildMatrix(report([stray]))).toEqual([]);
  });

  it("escapes the reason a check could not run", () => {
    const t = cat("C");
    const html = renderBotPermissionsPage({
      csrfToken: "t",
      remainingMs: 1000,
      report: report([permCheck("event-channels", "unknown", t)], {
        unknown: [
          { feature: feature("event-channels"), target: t, note: "<b>why</b>" },
        ],
      }),
    });
    expect(html).toContain("&lt;b&gt;why&lt;/b&gt;");
    expect(html).not.toContain("<b>why</b>");
  });

  it("carries the reason a check could not run onto the row", () => {
    const t = cat("Gone");
    const rows = buildMatrix(
      report([permCheck("event-channels", "unknown", t)], {
        unknown: [
          {
            feature: feature("event-channels"),
            target: t,
            note: "The configured category could not be found.",
          },
        ],
      }),
    );
    expect(rows[0].notes).toEqual([
      "The configured category could not be found.",
    ]);
  });

  it("covers every permission any registry entry needs once everything is switched on", () => {
    const checks = FEATURE_REQUIREMENTS.map((r) =>
      permCheck(r.id, "ok", r.scope === "guild" ? SERVER : cat("C")),
    );
    const labels = new Set(buildMatrix(report(checks)).map((r) => r.label));
    for (const r of FEATURE_REQUIREMENTS) {
      const expected = r.anyOf
        ? [r.needs.map((n) => n.name).join(" or ")]
        : r.needs.map((n) => n.name);
      for (const name of expected) expect(labels).toContain(name);
    }
    expect(buildMatrix(report(checks)).every((r) => r.status === "has")).toBe(
      true,
    );
  });
});

describe("fixSteps", () => {
  const f = feature("reaction-roles");
  const problem = (
    permission: string,
    target: PermissionTarget,
  ): BotPermissionReport["problems"][number] => ({
    permission,
    target,
    features: [f],
  });

  it("gives one step per place, server-wide first, with each permission named once in Discord's order", () => {
    const steps = fixSteps(
      report([], {
        problems: [
          problem("Manage Channels", cat("Events")),
          problem("Move Members", cat("Events")),
          problem("Manage Nicknames", SERVER),
          problem("Manage Roles", SERVER),
          problem("Manage Roles", SERVER),
        ],
      }),
    );
    expect(steps).toEqual([
      "Give the bot’s role <strong>Manage Roles</strong> and <strong>Manage Nicknames</strong> (server-wide).",
      "Give the bot’s role <strong>Manage Channels</strong> and <strong>Move Members</strong>, and make sure the category “Events” does not deny them.",
    ]);
  });

  it("makes one step of every role above the bot", () => {
    const role = (id: string, name: string): PermissionTarget => ({
      kind: "role",
      id,
      name,
    });
    const steps = fixSteps(
      report([], {
        problems: [
          problem(ROLE_ABOVE_BOT, role("1", "Staff")),
          problem(ROLE_ABOVE_BOT, role("2", "Mods")),
          problem(ROLE_ABOVE_BOT, role("1", "Staff")),
        ],
      }),
    );
    expect(steps).toEqual([
      "Move the bot’s role <strong>above</strong> these roles: “Staff”, “Mods” in Server Settings → Roles.",
    ]);
  });

  it("escapes names", () => {
    const [step] = fixSteps(
      report([], {
        problems: [problem("Manage Channels", cat("<img src=x>"))],
      }),
    );
    expect(step).toContain("&lt;img src=x&gt;");
    expect(step).not.toContain("<img");
  });

  it("has no steps when nothing is missing", () => {
    expect(fixSteps(report([]))).toEqual([]);
  });
});

describe("renderBotPermissionsPage lead", () => {
  const render = (r: BotPermissionReport): string =>
    renderBotPermissionsPage({ csrfToken: "t", remainingMs: 1000, report: r });
  const GREEN = "All permissions your switched-on features need are in place.";

  it("shows How to fix before the matrix when something is missing, and no green line", () => {
    const html = render(
      report(
        [
          permCheck("event-tags", "missing", SERVER, {
            missing: ["Manage Nicknames"],
          }),
        ],
        {
          problems: [
            {
              permission: "Manage Nicknames",
              target: SERVER,
              features: [feature("event-tags")],
            },
          ],
        },
      ),
    );
    expect(html.indexOf("How to fix")).toBeGreaterThan(-1);
    expect(html.indexOf("How to fix")).toBeLessThan(
      html.indexOf("Permissions</h2>"),
    );
    expect(html).not.toContain(GREEN);
  });

  it("shows the green line only when nothing is missing, unknown or unchecked", () => {
    expect(render(report([permCheck("event-tags", "ok", SERVER)]))).toContain(
      GREEN,
    );
    expect(
      render(report([permCheck("event-channels", "unchecked", null)])),
    ).not.toContain(GREEN);
    expect(
      render(
        report([permCheck("event-channels", "unknown", cat("C"))], {
          unknown: [
            {
              feature: feature("event-channels"),
              target: cat("C"),
              note: "n",
            },
          ],
        }),
      ),
    ).not.toContain(GREEN);
  });

  it("gives every state an icon and a word, and folds the Not needed rows with their count", () => {
    const html = render(
      report([
        permCheck("event-tags", "missing", SERVER, {
          missing: ["Manage Nicknames"],
        }),
        permCheck("event-channels", "unknown", cat("C")),
        permCheck("event-moves", "ok", cat("C")),
        permCheck("reaction-roles", "ok", SERVER, { enabled: false }),
      ]),
    );
    for (const word of ["Missing", "Not checked", "Has", "Not needed"]) {
      expect(html).toMatch(
        new RegExp(
          `class="kb-perm kb-perm--\\w+"><svg[^>]*aria-hidden="true"[^>]*>.*?</svg>${word}</span>`,
        ),
      );
    }
    expect(html).toMatch(
      /<details class="kb-disclosure"><summary>.*?Not needed <span class="kb-badge kb-badge--count">1<\/span>/,
    );
    expect(html).toContain("(off)");
  });
});

describe("a lock-down check that did not evaluate every grant never shows the rest as Has", () => {
  const CHANNEL: PermissionTarget = {
    kind: "channel",
    id: "n",
    name: "notices",
  };
  const lock = (missing: string[], assessed?: string[]): FeatureCheck => ({
    ...permCheck("notices-lock", missing.length ? "missing" : "ok", CHANNEL, {
      missing,
    }),
    ...(assessed ? { assessed } : {}),
  });
  const labels = (rows: ReturnType<typeof buildMatrix>): string[] =>
    rows
      .filter((r) => r.features.some((f) => f.id === "notices-lock"))
      .map((r) => r.label)
      .sort();

  it("shows every grant when all were evaluated", () => {
    const rows = buildMatrix(report([lock([])]));
    expect(labels(rows)).toContain("Create Public Threads");
    expect(labels(rows)).toContain("Manage Roles");
  });

  it("shows only Manage Roles (missing) when it is missing and the grants were not reached", () => {
    const rows = buildMatrix(
      report([lock(["Manage Roles"], ["Manage Roles"])]),
    );
    expect(labels(rows)).toEqual(["Manage Roles"]);
    expect(rows.find((r) => r.label === "Manage Roles")?.status).toBe(
      "missing",
    );
  });

  it("shows only Manage Roles (has) when an overwrite exemption waived the grants", () => {
    const rows = buildMatrix(report([lock([], ["Manage Roles"])]));
    expect(labels(rows)).toEqual(["Manage Roles"]);
    expect(rows.find((r) => r.label === "Manage Roles")?.status).toBe("has");
    expect(rows.some((r) => r.label === "Create Public Threads")).toBe(false);
  });
});
