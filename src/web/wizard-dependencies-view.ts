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
    /** The wizard step that sets a key, for the keys whose feature was chosen. */
    steps?: Record<string, number>;
  }[];
}

/** The first step of the wizard, with the current choices discarded on the next start. */
const WIZARD_RESTART_HREF = "/admin/wizard?reset=1";

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

function labelOf(key: string): string {
  const meta = (settingsMetadata as Record<string, { label?: string }>)[key];
  return meta?.label ?? key;
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
      .map((b) => {
        const steps = b.steps ?? {};
        const stepLink = (key: string): string => {
          const step = steps[key];
          return step === undefined
            ? settingRef(key, false)
            : `<a href="/admin/wizard?step=${step}">${escapeHtml(labelOf(key))}</a>`;
        };
        const it = b.related.length === 1 ? "it" : "them";
        const restart = `<a href="${WIZARD_RESTART_HREF}">Restart the wizard</a>`;
        // The blocker's own feature has a step only when it was chosen. Without
        // one there is nothing to go back to, so the only way to change it is a
        // restart (which discards the choices).
        const ownStep = steps[b.key] !== undefined;
        if (b.direction === "disable") {
          const relatedLinks = b.related.map(stepLink).join(" or ");
          const off = `Go back to ${relatedLinks} and switch ${it} off`;
          return ownStep
            ? `<li>Turning off ${settingRef(b.key, false)} needs ${refList(b.related)} turned off first. ${off}, or go back to the step for ${stepLink(b.key)} and leave it on.</li>`
            : `<li>Turning off ${settingRef(b.key, false)} needs ${refList(b.related)} turned off first. ${settingRef(b.key, false)} was not chosen, so there is no step for it. ${off}, or ${restart} and choose it on the first step (this starts your choices over).</li>`;
        }
        const leave = ownStep
          ? `go back to the step for ${stepLink(b.key)} and leave it off`
          : "leave it off";
        // Two different situations, two different advice. A prerequisite whose
        // feature was chosen has a step: it is switched off there, so go back.
        // One that was not chosen has no step, and switching it on in All
        // settings does not help because Apply turns off every feature that was
        // not chosen: only a restart (which discards the choices) changes it.
        const chosen = b.related.filter((k) => steps[k] !== undefined);
        const missing = b.related.filter((k) => steps[k] === undefined);
        const sentences = [
          `Turning on ${settingRef(b.key, false)} needs ${refList(b.related)} turned on too.`,
        ];
        if (chosen.length > 0) {
          sentences.push(
            `${chosen.length === 1 ? "It is" : "They are"} switched off in ${chosen.length === 1 ? "its" : "their"} own step: go back to ${chosen.map(stepLink).join(" or ")} and switch ${chosen.length === 1 ? "it" : "them"} on.`,
          );
        }
        if (missing.length > 0) {
          const it = missing.length === 1 ? "it" : "them";
          sentences.push(
            `${refList(missing)} ${missing.length === 1 ? "was" : "were"} not chosen, and turning ${it} on in All settings does not help, because Apply turns off every feature that was not chosen. ${restart} and choose ${it} on the first step (this starts your choices over).`,
          );
        }
        sentences.push(`Or ${leave}.`);
        return `<li>${sentences.join(" ")}</li>`;
      })
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
  <div><p class="kb-setting__name">Turn these off in the same apply</p><p class="kb-setting__desc" id="cascade-desc">${names}</p></div>
  <div class="kb-setting__control"><label class="kb-switch"><input type="checkbox" role="switch" name="cascadeOff" value="${escapeHtml(review.fingerprint)}" form="${WIZARD_APPLY_FORM_ID}" aria-describedby="cascade-desc"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Turn ${review.cascadeKeys.length === 1 ? "it" : "them"} off too</label></div>
</div></div>`,
    );
  }

  return parts.length > 0
    ? `<div class="kb-stack">${parts.join("\n")}</div>`
    : "";
}
