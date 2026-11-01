/**
 * How the Web UI words the slash-command sync check (#1638): one module, so the
 * Dashboard row, the All settings status line and the reset flash say the same
 * thing. Everything here is plain text: callers escape it for HTML, and a
 * flash or callout never carries markdown.
 */

import type { CommandSyncReport } from "../services/command-manager.js";

/** Where the existing Reload commands button sits. */
export const COMMAND_SYNC_HREF = "/admin/settings#commands-sync";

/** At most this many command names are listed; the rest are counted. */
export const COMMAND_SYNC_NAME_LIMIT = 5;

type OutOfSync = Extract<CommandSyncReport, { state: "out-of-sync" }>;

/** "/poll, /lfg" or "/a, /b, /c, /d, /e and 2 more". */
export function commandNameList(names: string[]): string {
  const shown = names.slice(0, COMMAND_SYNC_NAME_LIMIT).map((n) => `/${n}`);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** "2 to add (/poll, /lfg), 1 to remove (/event)": only the parts that exist. */
export function commandSyncParts(report: OutOfSync): string {
  const parts: string[] = [];
  if (report.added.length) {
    parts.push(
      `${report.added.length} to add (${commandNameList(report.added)})`,
    );
  }
  if (report.removed.length) {
    parts.push(
      `${report.removed.length} to remove (${commandNameList(report.removed)})`,
    );
  }
  if (report.changed.length) {
    parts.push(
      `${report.changed.length} to update (${commandNameList(report.changed)})`,
    );
  }
  return parts.join(", ");
}

/** "Slash commands are out of sync: 2 to add (/poll, /lfg), 1 to remove (/event)". */
export function commandSyncTitle(report: OutOfSync): string {
  return `Slash commands are out of sync: ${commandSyncParts(report)}`;
}

/** One sentence per kind of difference, in the member's terms. The fix is the caller's. */
export function commandSyncImpact(report: OutOfSync): string {
  const sentences: string[] = [];
  if (report.added.length) {
    sentences.push(
      `Members don't see ${commandNameList(report.added)} in Discord yet.`,
    );
  }
  if (report.removed.length) {
    sentences.push(
      `Members still see ${commandNameList(report.removed)} in Discord.`,
    );
  }
  if (report.changed.length) {
    sentences.push(
      `${commandNameList(report.changed)} still shows its old options or description.`,
    );
  }
  return sentences.join(" ");
}

/** "Not checked: Discord did not answer". The reason is already in plain words. */
export function commandSyncNotChecked(reason: string | undefined): string {
  return reason ? `Not checked: ${reason}` : "Not checked";
}

/** Why a check did not run, from the Dashboard's own time limit or the report. */
export function commandSyncReason(
  report: CommandSyncReport | null | undefined,
): string | undefined {
  return report && report.state === "unknown" ? report.reason : undefined;
}

const capitalise = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The state for the All settings status line (a status dot with a word, then
 * one sentence): a tone, the word, and what it means. The word is never
 * "In sync" unless the check read Discord and found no difference.
 */
export function commandSyncStatus(report: CommandSyncReport | null): {
  tone: "ok" | "warn";
  label: string;
  text: string;
} {
  if (report === null || report.state === "unknown") {
    const reason = commandSyncReason(report);
    return {
      tone: "warn",
      label: "Not checked",
      text: reason
        ? `${capitalise(reason)}. Whether the commands are in sync is not known.`
        : "Whether the commands are in sync is not known.",
    };
  }
  if (report.state === "in-sync") {
    return {
      tone: "ok",
      label: "In sync",
      text: "Discord has the slash commands the switched-on features need.",
    };
  }
  return {
    tone: "warn",
    label: "Out of sync",
    text: `${commandSyncParts(report)}. ${commandSyncImpact(report)} Reload commands applies the change.`,
  };
}

/**
 * What a flash after a bulk reset says about the commands (#1638), in place of
 * the old "You may need to Reload commands." guess. Plain text, one sentence.
 */
export function commandSyncFlashNote(report: CommandSyncReport | null): string {
  if (report?.state === "in-sync") return " Slash commands are in sync.";
  if (report?.state === "out-of-sync") {
    return ` ${commandSyncTitle(report)}. Use Reload commands to apply the change.`;
  }
  const reason = commandSyncReason(report);
  return reason
    ? ` Slash commands could not be checked: ${reason}.`
    : " Slash commands could not be checked.";
}
