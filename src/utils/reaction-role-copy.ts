import type { ReactionRoleMode } from "../models/reaction-role-config.js";

/**
 * The sentence a group picker's description gives about what reacting does,
 * written once for both places that post one (`reaction-role-service.ts` and
 * `reaction-role-group-service.ts`). It used to be the embed footer (#1522);
 * the footer now only names the feature (`docs/design/discord.md`).
 */
export function groupPickerHint(mode: ReactionRoleMode | string): string {
  if (mode === "unique") return "Pick one: reacting swaps you to that role.";
  if (mode === "sticky") return "Removing your reaction keeps the role.";
  return "Remove your reaction to lose the role.";
}

/** The group picker description: what to do, then one line per option. */
export function groupPickerDescription(
  groupName: string,
  mode: ReactionRoleMode | string,
  optionLines: readonly string[],
): string {
  return `React to choose your **${groupName}** role. ${groupPickerHint(mode)}\n\n${optionLines.join("\n")}`;
}
