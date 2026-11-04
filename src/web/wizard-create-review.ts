import { channelMention } from "./discord-labels.js";
import { escapeHtml } from "./html.js";
import { ChannelType } from "discord.js";
import { toneIcon } from "./icons.js";

/**
 * The Review entry for a channel or category the wizard will create (#1661).
 *
 * One list row per planned creation, in a Panel, with Mentions for the names
 * (a channel by its kind icon, a category in capitals and never with a `#`).
 * Plain text only: nothing here uses markdown characters. The wording is a
 * PROPOSAL for the owner; it is not in `docs/design` until approved.
 *
 * Rendering only. The plan comes from the server helper (#1659); the wizard
 * wires it in `wizard-create.ts` (#1662).
 */

/** One channel or category that Apply would create. */
export type PlannedCreation =
  | {
      kind: "text" | "voice";
      name: string;
      /** The label of the setting the new channel fills ("Quotes channel"). */
      settingLabel: string;
      /** The category it goes in; `null` when it is created outside any category. */
      parent: { name: string } | null;
    }
  | {
      kind: "category";
      name: string;
      settingLabel: string;
      /**
       * A sentence for the detail line (#1664), plain text. Set for the managed
       * voice category: the lobby is made in it by the voice feature, not by
       * this step. The wording is a PROPOSAL for the owner.
       */
      note?: string;
    };

const ACCESS_EVERYONE = "Visible to everyone who can see the server";

function entry(c: PlannedCreation): string {
  const type =
    c.kind === "voice"
      ? ChannelType.GuildVoice
      : c.kind === "category"
        ? ChannelType.GuildCategory
        : ChannelType.GuildText;
  const what =
    c.kind === "voice"
      ? "voice channel"
      : c.kind === "category"
        ? "category"
        : "text channel";
  const sentence = `Create the ${what} ${channelMention({ name: c.name, type })} for ${escapeHtml(c.settingLabel)}`;
  let detail: string;
  if (c.kind === "category") {
    detail = `${ACCESS_EVERYONE}.${c.note ? ` ${escapeHtml(c.note)}` : ""}`;
  } else if (c.parent) {
    const parent = channelMention({
      name: c.parent.name,
      type: ChannelType.GuildCategory,
    });
    detail = `In ${parent}. Inherits access from ${parent}.`;
  } else {
    detail = `Not in a category. ${ACCESS_EVERYONE}.`;
  }
  return `<li><span class="kb-list__main"><span>${sentence}</span><span class="kb-list__desc">${detail}</span></span></li>`;
}

/**
 * The Review block for planned creations; an empty string when there are none,
 * so a Review without creations renders as before.
 */
export function renderCreateReview(
  creations: readonly PlannedCreation[],
): string {
  if (creations.length === 0) return "";
  const id = "wizard-create-review";
  return `<section class="kb-panel" id="${id}" aria-labelledby="${id}-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}-h">Channels and categories to create</h2><span class="kb-panel__meta">${creations.length}</span></header>
  <div class="kb-panel__body kb-panel__body--flush">
    <ul class="kb-list">${creations.map(entry).join("")}</ul>
  </div>
  <footer class="kb-panel__foot"><p class="kb-help">Nothing is created until you apply. If applying fails, KoolBot removes what it created; anything it keeps because something now points at it, or could not remove, is named.</p></footer>
</section>`;
}

/**
 * Why Apply is blocked for the planned creations (#1662): the bot cannot
 * create, a name matches two channels, the server could not be read. An error
 * Callout in the style of the dependency review's; empty when there is nothing
 * to say. The wording is a PROPOSAL for the owner.
 */
export function renderCreateProblems(problems: readonly string[]): string {
  if (problems.length === 0) return "";
  const items = problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  return `<div class="kb-callout kb-callout--err" role="alert" id="wizard-create-problems">${toneIcon("err")}<div class="kb-callout__body"><p class="kb-callout__title">The channels can't be created</p><ul>${items}</ul><p class="kb-callout__text">Nothing is changed until this is fixed. Go back to the step that plans the channel, or fix it in Discord and open Review again.</p></div></div>`;
}
