/**
 * Channels, categories and roles labelled the way Discord labels them (#1303).
 *
 * Discord shows what kind of thing a name is: `#` for a text channel, a
 * speaker for voice, a megaphone for an announcement channel, categories as
 * plain UPPERCASE headers and `@` for roles. The Web UI used to put `#` in
 * front of every channel-like name, so voice channels and categories read as
 * text channels. This module is the one place that decides how a name is
 * shown; `__tests__/web/discord-labels-guard.test.ts` fails when a page goes
 * back to writing `#${name}` itself. Design: `docs/design/components.md`
 * (Mention, Picker).
 *
 * Two outputs, because two places render names:
 *
 * - HTML (`channelMention`, `roleMention`, `missingMention`): `span.kb-mention`
 *   with an inline icon whose accessible name is the kind. For tables, `dd`s
 *   and sentences.
 * - Plain text (`channelText`, `roleText`, `missingText`): Unicode, for the
 *   places SVG cannot go: native `<option>`s, the selection summary under a
 *   multi-select, and status-line chips (their text is escaped on output).
 *
 * The functions that return HTML escape what they are given.
 */

import { ChannelType } from "discord.js";
import { escapeHtml } from "./html.js";
import { ICONS } from "./icons.js";

/** What a channel is, as far as a label is concerned. */
export type ChannelKind =
  "text" | "announcement" | "voice" | "stage" | "forum" | "thread" | "category";

/**
 * Map a Discord channel type to a label kind. Returns null for a type with no
 * label (DMs, directories) and for "not found", so a caller can show the
 * channel as unavailable instead of guessing `#`.
 */
export function channelKindOf(
  type: ChannelType | number | null | undefined,
): ChannelKind | null {
  switch (type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return "forum";
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "thread";
    case ChannelType.GuildCategory:
      return "category";
    default:
      return null;
  }
}

/**
 * The Discord channel type named `name` (`ChannelType[type]`, as the scan and
 * the Channel Manager keep it: "GuildVoice"), or null when the name is not a
 * channel type. For callers that hold the type as a word.
 */
export function channelTypeByName(
  name: string | null | undefined,
): ChannelType | null {
  if (!name) return null;
  const type = (ChannelType as unknown as Record<string, unknown>)[name];
  return typeof type === "number" ? type : null;
}

/** A channel to label: its name and Discord type (null/undefined = not found). */
export interface ChannelRef {
  name: string;
  type: ChannelType | number | null | undefined;
  /**
   * Name kept when the row was written, for a voice room that may be gone by
   * now (#1420). Used only when `type` is not found: the row is shown as a
   * deleted voice room by this name rather than as unavailable.
   */
  storedName?: string | null;
}

interface KindInfo {
  /** Accessible name of the icon. */
  label: string;
  /** Heading of the `<optgroup>` / picker group the kind belongs to. */
  group: string;
  /** Unicode glyph for places SVG cannot go; `#` for text, as Discord does. */
  glyph: string;
  /** Children of the 24x24 Lucide `svg` (ISC licence, lucide-static 1.61.0; hash, megaphone, volume-2 and triangle-alert come from `ICONS`). */
  icon: string;
}

const KINDS: Record<ChannelKind, KindInfo> = {
  text: {
    label: "Text channel",
    group: "Text channels",
    glyph: "#",
    icon: ICONS.hash,
  },
  announcement: {
    label: "Announcement channel",
    group: "Text channels",
    glyph: "📢",
    icon: ICONS.megaphone,
  },
  voice: {
    label: "Voice channel",
    group: "Voice channels",
    glyph: "🔊",
    icon: ICONS["volume-2"],
  },
  stage: {
    label: "Stage channel",
    group: "Voice channels",
    glyph: "🎙️",
    icon:
      `<path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"/>` +
      `<path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"/>` +
      `<circle cx="16" cy="7" r="5"/>`,
  },
  forum: {
    label: "Forum channel",
    group: "Forum channels",
    glyph: "💬",
    icon:
      `<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>` +
      `<path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>`,
  },
  thread: {
    label: "Thread",
    group: "Threads",
    glyph: "🧵",
    icon: `<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>`,
  },
  category: {
    label: "Category",
    group: "Categories",
    glyph: "📁",
    icon: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  },
};

const ALERT_ICON = ICONS["triangle-alert"];

function svg(children: string, label: string): string {
  return `<svg class="kb-icon" viewBox="0 0 24 24" role="img" aria-label="${escapeHtml(label)}" focusable="false">${children}</svg>`;
}

/** Heading of the `<optgroup>` / picker group a channel kind is listed under. */
export function channelGroupLabel(type: ChannelType | number): string {
  const kind = channelKindOf(type);
  return kind ? KINDS[kind].group : "Other";
}

/**
 * The icon of every channel kind as `svg` markup (accessible name = the kind),
 * for the searchable picker script, which builds its rows in the browser from
 * the wrapper's `data-picker-meta` (#1394).
 */
export function channelKindIcons(): Record<ChannelKind, string> {
  const out = {} as Record<ChannelKind, string>;
  for (const kind of Object.keys(KINDS) as ChannelKind[]) {
    out[kind] = svg(KINDS[kind].icon, KINDS[kind].label);
  }
  return out;
}

// ---- HTML ------------------------------------------------------------------

/**
 * A channel or category as a `kb-mention`: icon plus name. A category is shown
 * in capitals by `kb-mention--category` (the name itself keeps its case). A
 * channel whose type is unknown (deleted, or the bot cannot see it) is shown
 * as unavailable rather than as a text channel.
 */
export function channelMention(ref: ChannelRef): string {
  const kind = channelKindOf(ref.type);
  if (!kind) {
    return ref.storedName
      ? deletedVoiceMention(ref.storedName)
      : missingMention(ref.name);
  }
  const info = KINDS[kind];
  const cls =
    kind === "category" ? "kb-mention kb-mention--category" : "kb-mention";
  return `<span class="${cls}">${svg(info.icon, info.label)}${escapeHtml(ref.name)}</span>`;
}

/**
 * A channel known by its name and its type as a word (`ChannelType[type]`,
 * "GuildVoice"), the way the scan and the Channel Manager keep it. A type with
 * no label (a directory) is shown by its plain, escaped name: the channel
 * exists, so it is not "unavailable".
 */
export function namedChannelMention(
  name: string,
  typeName: string | null | undefined,
): string {
  const type = channelTypeByName(typeName);
  return type !== null && channelKindOf(type)
    ? channelMention({ name, type })
    : escapeHtml(name);
}

/** A role as a `kb-mention`: `@Name`, no icon, as Discord shows it. */
export function roleMention(name: string): string {
  return `<span class="kb-mention">@${escapeHtml(name)}</span>`;
}

/**
 * A voice room Discord no longer knows, by the name stored when the row was
 * written (#1420): the neutral voice icon, the name and a muted "(deleted)".
 */
export function deletedVoiceMention(storedName: string): string {
  return `<span class="kb-mention">${svg(KINDS.voice.icon, "Voice channel")}${escapeHtml(storedName)}</span> <span class="kb-muted">(deleted)</span>`;
}

/** An id that no longer resolves to anything: an alert icon and "(unavailable)". */
export function missingMention(id: string): string {
  return `<span class="kb-mention kb-mention--missing">${svg(ALERT_ICON, "Unavailable")}${escapeHtml(id)} (unavailable)</span>`;
}

// ---- plain text ------------------------------------------------------------

/**
 * A channel as plain text (not escaped): `# general`, `🔊 Lobby`, `📁 Events`.
 * `parentName` adds the category the way Discord's autocomplete shows it, in
 * capitals as the design manual's no-JavaScript fallback does
 * (`🔊 Lobby · SCRATCH`). Unknown type: `⚠ <name> (unavailable)`.
 */
export function channelText(ref: ChannelRef, parentName?: string): string {
  const kind = channelKindOf(ref.type);
  if (!kind) {
    return ref.storedName
      ? `${KINDS.voice.glyph} ${ref.storedName} (deleted)`
      : missingText(ref.name);
  }
  const head = `${KINDS[kind].glyph} ${ref.name}`;
  return parentName && kind !== "category"
    ? `${head} · ${parentName.toUpperCase()}`
    : head;
}

/** A role as plain text (not escaped): `@Moderators`. */
export function roleText(name: string): string {
  return `@${name}`;
}

/** An unresolved id as plain text (not escaped): `⚠ 1234 (unavailable)`. */
export function missingText(id: string): string {
  return `⚠ ${id} (unavailable)`;
}
