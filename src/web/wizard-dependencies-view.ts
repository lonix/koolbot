/**
 * The dependency part of the Setup wizard's Review step (#1622): what turning
 * a feature off also needs, and what Apply would refuse. Built from existing
 * components only: Callout, SettingRow and Switch.
 */
import { settingsMetadata } from "../services/config-schema.js";
import { escapeHtml } from "./html.js";
import { toneIcon } from "./icons.js";

/** The slice of the wizard's dependency plan the page draws. */
export interface WizardDependencyReview {
  cascade: { key: string; dependents: string[] }[];
  cascadeKeys: string[];
  /** Posted back by the confirm switch; Apply compares it with a fresh plan. */
  fingerprint: string;
  blockers: {
    key: string;
    direction: "enable" | "disable";
    related: string[];
  }[];
}

/** The id of the Apply form, so the confirm switch can sit outside it. */
export const WIZARD_APPLY_FORM_ID = "wizard-apply-form";

/** Human name first, the key in mono, linked to its section of All settings. */
function settingRef(key: string, link: boolean): string {
  const meta = (
    settingsMetadata as Record<string, { label?: string; category: string }>
  )[key];
  const name = escapeHtml(meta?.label ?? key);
  const named = link
    ? `<a href="/admin/settings#section-${escapeHtml(meta?.category ?? key.split(".")[0])}">${name}</a>`
    : `<strong>${name}</strong>`;
  return `${named} (<span class="kb-mono">${escapeHtml(key)}</span>)`;
}

function refList(keys: string[]): string {
  const refs = keys.map((k) => settingRef(k, true));
  return refs.length < 2
    ? refs.join("")
    : `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
}

/** True when Apply must stay off: something is refused that confirming cannot fix. */
export function dependencyReviewBlocksApply(
  review: WizardDependencyReview | null | undefined,
): boolean {
  return (review?.blockers.length ?? 0) > 0;
}

export function renderDependencyReview(
  review: WizardDependencyReview | null | undefined,
): string {
  if (!review) return "";
  const parts: string[] = [];

  if (review.blockers.length > 0) {
    const items = review.blockers
      .map((b) =>
        b.direction === "enable"
          ? `<li>Turning on ${settingRef(b.key, false)} needs ${refList(b.related)} turned on too. Go back to its step and switch ${b.related.length === 1 ? "it" : "them"} on, or leave ${settingRef(b.key, false)} off.</li>`
          : `<li>Turning off ${settingRef(b.key, false)} needs ${refList(b.related)} turned off first.</li>`,
      )
      .join("");
    parts.push(
      `<div class="kb-callout kb-callout--err" role="alert">${toneIcon("err")}<div class="kb-callout__body"><p class="kb-callout__title">These settings can't be applied together</p><ul>${items}</ul><p class="kb-callout__text">Nothing is changed until this is fixed. Your other choices are kept.</p></div></div>`,
    );
  }

  if (review.cascade.length > 0) {
    const items = review.cascade
      .map(
        (c) =>
          `<li>Turning off ${settingRef(c.key, false)} also needs ${refList(c.dependents)} turned off.</li>`,
      )
      .join("");
    const names = review.cascadeKeys
      .map((k) => settingRef(k, false))
      .join(", ");
    parts.push(
      `<div class="kb-callout kb-callout--warn" role="status">${toneIcon("warn")}<div class="kb-callout__body"><p class="kb-callout__title">Some parts need a feature you are turning off</p><ul>${items}</ul><p class="kb-callout__text">Apply stops here until you confirm turning ${review.cascadeKeys.length === 1 ? "it" : "them"} off below.</p></div></div>
<div class="kb-settings"><div class="kb-setting">
  <div><p class="kb-setting__name" id="cascade-name">Turn these off in the same apply</p><p class="kb-setting__desc" id="cascade-desc">${names}</p></div>
  <div class="kb-setting__control"><label class="kb-switch"><input type="checkbox" role="switch" name="cascadeOff" value="${escapeHtml(review.fingerprint)}" form="${WIZARD_APPLY_FORM_ID}" aria-labelledby="cascade-name" aria-describedby="cascade-desc"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Turn ${review.cascadeKeys.length === 1 ? "it" : "them"} off too</label></div>
</div></div>`,
    );
  }

  return parts.length > 0
    ? `<div class="kb-stack" style="margin-bottom: var(--space-3)">${parts.join("\n")}</div>`
    : "";
}
