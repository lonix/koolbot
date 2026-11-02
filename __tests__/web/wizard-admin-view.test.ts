/**
 * The Setup wizard's Administrator callouts and its closing "narrow the bot's
 * permissions" page (#1617): every state says what it means in words, claims
 * nothing it does not know, and keeps callout text plain.
 */
import { describe, it, expect } from "@jest/globals";
import {
  renderAdministratorCallout,
  renderAdministratorContinue,
} from "../../src/web/wizard-admin-view.js";
import { renderWizardDonePage } from "../../src/web/wizard-done-view.js";
import type {
  BotPermissionReport,
  FeatureRef,
} from "../../src/services/bot-permission-check.js";
import { FEATURE_REQUIREMENTS } from "../../src/services/bot-permission-registry.js";

const INVITE = "https://discord.com/oauth2/authorize?client_id=1&permissions=8";
const INVITE_HTML =
  "https://discord.com/oauth2/authorize?client_id=1&amp;permissions=8";
const link = {
  kind: "link",
  href: "/admin/wizard?step=confirm&recheck=1",
} as const;

function calloutText(html: string): string {
  return [...html.matchAll(/<p class="kb-callout__(?:title|text)">([^<]*)/g)]
    .map((m) => m[1])
    .join(" ");
}

describe("renderAdministratorCallout", () => {
  it("has: an ok callout with no action", () => {
    const html = renderAdministratorCallout({
      check: { state: "has" },
      inviteUrl: INVITE,
      stage: "start",
      checkAgain: link,
    });
    expect(html).toContain("kb-callout--ok");
    expect(html).toContain("The bot has Administrator");
    expect(html).not.toContain("Check again");
  });

  it("missing at the start: warns, lists what may fail, links the invite, offers Check again as a button that posts the form", () => {
    const html = renderAdministratorCallout({
      check: { state: "missing" },
      inviteUrl: INVITE,
      stage: "start",
      checkAgain: { kind: "button", formaction: "/admin/wizard/check" },
    });
    expect(html).toContain("kb-callout--warn");
    expect(html).toContain("roles, channels and categories may fail");
    expect(html).toContain(`href="${INVITE_HTML}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('formaction="/admin/wizard/check"');
    expect(html).toContain("The wizard asks you to confirm at Review");
  });

  it("missing at Review: points at the switch and offers Check again as a link", () => {
    const html = renderAdministratorCallout({
      check: { state: "missing" },
      inviteUrl: null,
      stage: "review",
      checkAgain: link,
    });
    expect(html).toContain("switch on Continue without Administrator below");
    expect(html).toContain('href="/admin/wizard?step=confirm&amp;recheck=1"');
    // No invite link known: the role setting in Discord is still said.
    expect(html).not.toContain("invite link");
    expect(html).toContain("Server Settings, then Roles");
  });

  it("unknown: says so, escapes the reason, and claims neither way", () => {
    const html = renderAdministratorCallout({
      check: { state: "unknown", reason: "<b>x</b>" },
      inviteUrl: INVITE,
      stage: "review",
      checkAgain: link,
    });
    expect(html).toContain("Administrator could not be checked");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("The bot has Administrator");
    expect(html).not.toContain("does not have Administrator");
  });

  it.each(["has", "missing", "unknown"] as const)(
    "%s: callout text is plain text, no markdown",
    (state) => {
      const html = renderAdministratorCallout({
        check: state === "unknown" ? { state, reason: "No." } : { state },
        inviteUrl: INVITE,
        stage: "review",
        checkAgain: link,
      });
      expect(calloutText(html)).not.toMatch(/[`*_]{1,}\w/);
    },
  );
});

describe("renderAdministratorContinue", () => {
  it("is a labelled switch joined to the Apply form, only when Administrator is missing", () => {
    const html = renderAdministratorContinue(
      { state: "missing" },
      "apply-form",
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('name="continueWithoutAdmin"');
    expect(html).toContain('form="apply-form"');
    expect(html).toContain('aria-describedby="admin-continue-desc"');
    // The control announces itself by the owner's term, the one the callout and the refusal use.
    expect(html).toMatch(/<\/span>Continue without Administrator<\/label>/);
    expect(renderAdministratorContinue({ state: "has" }, "f")).toBe("");
    expect(
      renderAdministratorContinue({ state: "unknown", reason: "x" }, "f"),
    ).toBe("");
  });
});

describe("renderWizardDonePage", () => {
  const ref = (id: string): FeatureRef => {
    const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
    if (!r) throw new Error(id);
    return {
      id: r.id,
      area: r.area,
      feature: r.feature,
      effect: r.effect,
      fix: r.fix,
    };
  };
  const server = { kind: "server" as const, id: null, name: "Guild" };
  const report: BotPermissionReport = {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [
      {
        feature: ref("event-tags"),
        kind: "permission",
        enabled: true,
        outcome: "ok",
        target: server,
        missing: [],
      },
      {
        feature: ref("reaction-roles"),
        kind: "permission",
        enabled: false,
        outcome: "ok",
        target: server,
        missing: [],
      },
    ],
  };
  const base = { csrfToken: "t", remainingMs: 1000 };

  it("lists the needed permissions with their features, folds the unneeded ones, and gives the swap steps", () => {
    const html = renderWizardDonePage({
      ...base,
      report,
      admin: { state: "has" },
    });
    expect(html).toContain("What your features need");
    expect(html).toContain("Manage Nicknames");
    expect(html).toContain("Not needed by your features");
    expect(html).toContain("Swap Administrator for these");
    expect(html).toContain("Switch off Administrator");
    expect(html).toContain('href="/admin/bot-permissions"');
    expect(html).toContain(
      "never changes the bot's permissions in Discord itself",
    );
    // A read-only page: nothing on it posts to the wizard.
    expect(html).not.toContain('action="/admin/wizard');
    // One primary button in the page's own content (the layout has its own).
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(main.match(/kb-btn--primary/g)).toHaveLength(1);
  });

  it("drops the swap steps when the bot has no Administrator to swap", () => {
    const html = renderWizardDonePage({
      ...base,
      report,
      admin: { state: "missing" },
    });
    expect(html).toContain("There is nothing to swap");
    expect(html).not.toContain("Swap Administrator for these");
  });

  it("says the permissions could not be checked instead of listing nothing", () => {
    const html = renderWizardDonePage({
      ...base,
      admin: { state: "unknown", reason: "x" },
      report: { ...report, available: false, reason: "Blind.", checks: [] },
    });
    expect(html).toContain("could not be checked");
    expect(html).toContain("Blind.");
    expect(html).not.toContain("What your features need");
  });

  it("links the Event host job, escaped", () => {
    const html = renderWizardDonePage({
      ...base,
      report,
      admin: { state: "has" },
      hostJobId: "a&b",
    });
    expect(html).toContain("/admin/role-groups?job=a%26b");
  });
});

type PermissionTargetLike = { kind: "channel"; id: string; name: string };

describe("renderWizardDonePage never calls a permission unneeded that something uses", () => {
  const server = { kind: "server" as const, id: null, name: "Guild" };
  const refOf = (id: string): FeatureRef => {
    const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
    if (!r) throw new Error(id);
    return {
      id: r.id,
      area: r.area,
      feature: r.feature,
      effect: r.effect,
      fix: r.fix,
    };
  };
  const reportWith = (
    checks: BotPermissionReport["checks"],
  ): BotPermissionReport => ({
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks,
  });
  const base = {
    csrfToken: "t",
    remainingMs: 1000,
    admin: { state: "has" } as const,
  };
  /** The page's own content, without the layout. */
  const mainOf = (html: string): string =>
    html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  /** The part of the page before the folded "not needed" list, and the folded list. */
  const split = (html: string): { before: string; folded: string } => {
    const main = mainOf(html);
    const at = main.indexOf("Not needed by your features");
    return at < 0
      ? { before: main, folded: "" }
      : { before: main.slice(0, at), folded: main.slice(at) };
  };

  it("keeps Read Message History needed when looking for group is on with no channel set (it posts where it is used)", () => {
    const html = renderWizardDonePage({
      ...base,
      report: reportWith([
        {
          feature: refOf("lfg-post"),
          kind: "permission",
          // What the checker reports for an optional channel left empty ...
          enabled: false,
          outcome: "unchecked",
          target: null,
          missing: [],
          // ... except that the feature is on and posts in the invoking channel.
          needsServerWide: true,
        },
      ]),
    });
    const { before, folded } = split(html);
    expect(before).toContain("Read Message History");
    expect(before).toContain("Looking for group");
    expect(folded).not.toContain("Read Message History");
  });

  it("leaves Read Message History in the not-needed list when looking for group is off", () => {
    const html = renderWizardDonePage({
      ...base,
      report: reportWith([
        {
          feature: refOf("lfg-post"),
          kind: "permission",
          enabled: false,
          outcome: "unchecked",
          target: null,
          missing: [],
        },
      ]),
    });
    const { before, folded } = split(html);
    expect(folded).toContain("Read Message History");
    expect(before).not.toContain("Read Message History");
  });

  it("lists the permissions KoolBot uses but does not check (/ban, /timeout) as used, never as not needed", () => {
    const html = renderWizardDonePage({
      ...base,
      report: reportWith([
        {
          feature: refOf("event-tags"),
          kind: "permission",
          enabled: true,
          outcome: "ok",
          target: server,
          missing: [],
        },
      ]),
    });
    const { before, folded } = split(html);
    for (const name of ["Ban Members", "Timeout Members"]) {
      expect(before).toContain(name);
      expect(folded).not.toContain(name);
    }
    expect(before).toContain("/ban");
    expect(before).toContain("/timeout");
    expect(before).toContain("Used, but not checked here");
  });

  it("keeps every feature in the Needed by cell when one permission has several matrix rows", () => {
    const channel = (id: string): PermissionTargetLike => ({
      kind: "channel",
      id,
      name: id,
    });
    const check = (
      id: string,
      outcome: "ok" | "missing",
      target: PermissionTargetLike,
    ): BotPermissionReport["checks"][number] => ({
      feature: refOf(id),
      kind: "permission",
      enabled: true,
      outcome,
      target,
      missing: outcome === "missing" ? ["Send Messages"] : [],
    });
    // Send Messages is in place for one feature and missing for another, so the
    // matrix gives it two non-off rows.
    const two = renderWizardDonePage({
      ...base,
      report: reportWith([
        check("quotes-post", "ok", channel("quotes")),
        check("welcome-post", "missing", channel("welcome")),
      ]),
    });
    const cell = (html: string): string => {
      const main = mainOf(html);
      const at = main.indexOf('<th scope="row">Send Messages</th>');
      return main.slice(at, main.indexOf("</tr>", at));
    };
    const rowsFor =
      mainOf(two).split('<th scope="row">Send Messages</th>').length - 1;
    expect(rowsFor).toBe(1);
    const both = cell(two);
    expect(both).toContain(refOf("quotes-post").feature);
    expect(both).toContain(refOf("welcome-post").feature);
    // Control: one row, one feature.
    const one = renderWizardDonePage({
      ...base,
      report: reportWith([check("quotes-post", "ok", channel("quotes"))]),
    });
    expect(cell(one)).toContain(refOf("quotes-post").feature);
    expect(cell(one)).not.toContain(refOf("welcome-post").feature);
  });

  it("keeps the Announcements permissions needed when it is on with no schedule (a message sent once picks its channel), and not needed when it is off", () => {
    const check = (
      id: string,
      flagged: boolean,
    ): BotPermissionReport["checks"][number] => ({
      feature: refOf(id),
      kind: "permission",
      enabled: false,
      outcome: "unchecked",
      target: null,
      missing: [],
      ...(flagged ? { needsServerWide: true } : {}),
    });
    const ids = [
      "announcements-post",
      "announcements-embed",
      "announcements-mentions",
    ];
    const on = renderWizardDonePage({
      ...base,
      report: reportWith(ids.map((id) => check(id, true))),
    });
    const { before, folded } = split(on);
    for (const name of [
      "Embed Links",
      "Mention @everyone, @here and All Roles",
      "Send Messages",
    ]) {
      expect(before).toContain(name);
      expect(folded).not.toContain(name);
    }
    expect(before).toContain(refOf("announcements-mentions").area);
    const off = renderWizardDonePage({
      ...base,
      report: reportWith(ids.map((id) => check(id, false))),
    });
    const control = split(off);
    expect(control.folded).toContain("Mention @everyone, @here and All Roles");
    expect(control.before).not.toContain("Mention @everyone");
  });

  it("does not claim that every other permission is not needed, and says what the list is", () => {
    const html = renderWizardDonePage({ ...base, report: reportWith([]) });
    const main = mainOf(html);
    expect(main).not.toMatch(/every other/i);
    expect(main).not.toContain("is not needed either");
    expect(main).toContain("what KoolBot checks and uses");
    expect(main).toContain('href="/admin/bot-permissions"');
  });
});
