/**
 * The wording of an event's groups (#1471): what a group and a leader are
 * called ("Team", "Captain"). A fixed list of words is offered as a dropdown, a
 * server default in the Events settings fills in when an event names none, and
 * Custom keeps free text valid, so a label saved before the dropdown existed
 * still works and shows as Custom.
 *
 * Pure and free of config, Discord and Mongo reads: callers read the two config
 * keys and pass the result in (`WordingDefaults`), like the group count limits.
 */

/** The words the group dropdown offers, in the order shown. */
export const GROUP_WORDING_OPTIONS = [
  "Team",
  "Squad",
  "Room",
  "Party",
] as const;
/** The words the leader dropdown offers, in the order shown. */
export const LEADER_WORDING_OPTIONS = ["Leader", "Captain"] as const;

/** The dropdown value for "type my own wording". Empty means the server default. */
export const WORDING_CUSTOM = "custom";

export type WordingKind = "group" | "leader";

/** What an event with no wording of its own is called. */
export interface WordingDefaults {
  group: string;
  leader: string;
}

/** The wording before a server sets one, and when a stored value is unusable. */
export const BUILTIN_WORDING: WordingDefaults = {
  group: GROUP_WORDING_OPTIONS[0],
  leader: LEADER_WORDING_OPTIONS[0],
};

export const WORDING_OPTIONS: Record<WordingKind, readonly string[]> = {
  group: GROUP_WORDING_OPTIONS,
  leader: LEADER_WORDING_OPTIONS,
};

/** The config key of each server default. */
export const WORDING_CONFIG_KEYS: Record<WordingKind, string> = {
  group: "events.groups.group_label",
  leader: "events.groups.leader_label",
};

/**
 * One configured word, or the built-in when it is empty. The Settings page only
 * writes a listed word, but the value is still checked here (the database can be
 * edited by hand): anything else falls back, so a bad value never reaches an
 * event.
 */
function configured(kind: WordingKind, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return WORDING_OPTIONS[kind].includes(text) ? text : BUILTIN_WORDING[kind];
}

/** Read the two server defaults through `getString` (a `ConfigService`). */
export async function loadWordingDefaults(config: {
  getString(key: string, fallback: string): Promise<string>;
}): Promise<WordingDefaults> {
  try {
    const [group, leader] = await Promise.all([
      config.getString(WORDING_CONFIG_KEYS.group, BUILTIN_WORDING.group),
      config.getString(WORDING_CONFIG_KEYS.leader, BUILTIN_WORDING.leader),
    ]);
    return {
      group: configured("group", group),
      leader: configured("leader", leader),
    };
  } catch {
    // The wording is a convenience: an unreadable config shows the built-ins.
    return { ...BUILTIN_WORDING };
  }
}

/**
 * The dropdown value that shows a stored or posted wording: the listed word it
 * equals (exactly), `""` for none (the server default), else Custom.
 */
export function wordingChoiceFor(kind: WordingKind, value: string): string {
  const text = value.trim();
  if (!text) return "";
  return WORDING_OPTIONS[kind].includes(text) ? text : WORDING_CUSTOM;
}

/** What a posted dropdown choice means. */
export type WordingChoice =
  | { kind: "text" }
  | { kind: "word"; word: string }
  | { kind: "default" }
  | { kind: "unknown" };

/**
 * Read a posted choice against the fixed list. `undefined` (the field was not
 * posted: the preset editor, a script, an older page) is the free-text path, so
 * everything that posts only the text box keeps working.
 */
export function readWordingChoice(
  kind: WordingKind,
  posted: string | undefined,
): WordingChoice {
  if (posted === undefined || posted === WORDING_CUSTOM)
    return { kind: "text" };
  if (posted === "") return { kind: "default" };
  return WORDING_OPTIONS[kind].includes(posted)
    ? { kind: "word", word: posted }
    : { kind: "unknown" };
}
