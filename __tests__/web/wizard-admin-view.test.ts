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
const INVITE_HTML = INVITE.replace("&", "&amp;");
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
