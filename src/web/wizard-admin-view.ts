/**
 * The Administrator part of the Setup wizard (#1617): a Callout at the start
 * and at Review that says whether the bot has Administrator, and, at Review,
 * the explicit choice to carry on without it. Built from existing components
 * only: Callout, Button, SettingRow and Switch. All text is plain text.
 *
 * The wording is a proposal for the owner (see the PR); every string lives here
 * so it is one place to change.
 */
import type { AdministratorCheck } from "../services/wizard-admin-check.js";
import { escapeHtml } from "./html.js";
import { toneIcon } from "./icons.js";

/** The name of the switch posted with the Apply form. */
export const ADMIN_CONTINUE_FIELD = "continueWithoutAdmin";

/** What may fail without Administrator. */
const MAY_FAIL =
  "Creating roles, channels and categories may fail, and so may anything else that needs a permission the bot lacks.";

export interface AdministratorCalloutProps {
  check: AdministratorCheck;
  /** The invite link that asks for Administrator; null when the bot does not know its own id. */
  inviteUrl: string | null;
  stage: "start" | "review";
  /**
   * How *Check again* runs: a link that reloads the page (Review, where the
   * wizard's choices live in the server session) or a button that posts the
   * form it sits in (the first page, where the ticked features are the choices).
   */
  checkAgain:
    { kind: "link"; href: string } | { kind: "button"; formaction: string };
}

function checkAgainButton(props: AdministratorCalloutProps): string {
  return props.checkAgain.kind === "link"
    ? `<a class="kb-btn kb-btn--sm" href="${escapeHtml(props.checkAgain.href)}">Check again</a>`
    : `<button type="submit" class="kb-btn kb-btn--sm" formaction="${escapeHtml(props.checkAgain.formaction)}" formnovalidate>Check again</button>`;
}

export function renderAdministratorCallout(
  props: AdministratorCalloutProps,
): string {
  const { check } = props;
  if (check.state === "has") {
    return `<div class="kb-callout kb-callout--ok" role="status" data-wizard-admin="has">${toneIcon("ok")}<div class="kb-callout__body"><p class="kb-callout__title">The bot has Administrator</p><p class="kb-callout__text">The wizard can create the roles, channels and categories it needs. After you apply, it shows how to narrow the bot to what your features need.</p></div></div>`;
  }
  if (check.state === "unknown") {
    return `<div class="kb-callout" role="status" data-wizard-admin="unknown">${toneIcon("")}<div class="kb-callout__body"><p class="kb-callout__title">Administrator could not be checked</p><p class="kb-callout__text">${escapeHtml(check.reason)} The wizard does not know whether the bot has it, and nothing is blocked. Choose Check again, or carry on.</p></div><div class="kb-callout__actions">${checkAgainButton(props)}</div></div>`;
  }
  const invite = props.inviteUrl
    ? `<li>Open the <a href="${escapeHtml(props.inviteUrl)}" target="_blank" rel="noopener noreferrer">invite link that asks for Administrator</a> (opens in a new tab) and authorise it for this server.</li>`
    : "";
  const role = `<li>${invite ? "Or in" : "In"} Discord, open Server Settings, then Roles, open the bot's role and switch on Administrator.</li>`;
  const carryOn =
    props.stage === "review"
      ? "You can apply without it: switch on Continue without Administrator below."
      : "You can carry on without it. The wizard asks you to confirm at Review.";
  return `<div class="kb-callout kb-callout--warn kb-callout--wrap" role="status" data-wizard-admin="missing">${toneIcon("warn")}<div class="kb-callout__body"><p class="kb-callout__title">The bot does not have Administrator</p><p class="kb-callout__text">${escapeHtml(MAY_FAIL)} To give it Administrator:</p><ul>${invite}${role}</ul><p class="kb-callout__text">Then choose Check again. Your choices in the wizard are kept. ${escapeHtml(carryOn)}</p></div><div class="kb-callout__actions">${checkAgainButton(props)}</div></div>`;
}

/**
 * The explicit choice at Review: a switch posted with the Apply form (same
 * pattern as the dependency review's confirm switch). Empty unless the bot is
 * known to lack Administrator.
 */
export function renderAdministratorContinue(
  check: AdministratorCheck,
  applyFormId: string,
): string {
  if (check.state !== "missing") return "";
  return `<div class="kb-settings"><div class="kb-setting">
  <div><p class="kb-setting__name">Continue without Administrator</p><p class="kb-setting__desc" id="admin-continue-desc">Apply stops here until you switch this on. Creating roles, channels and categories may then fail.</p></div>
  <div class="kb-setting__control"><label class="kb-switch"><input type="checkbox" role="switch" name="${ADMIN_CONTINUE_FIELD}" value="1" form="${escapeHtml(applyFormId)}" aria-describedby="admin-continue-desc"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Continue without Administrator</label></div>
</div></div>`;
}
