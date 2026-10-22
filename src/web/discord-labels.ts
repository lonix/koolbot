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

/** A channel to label: its name and Discord type (null/undefined = not found). */
export interface ChannelRef {
  name: string;
  type: ChannelType | number | null | undefined;
}

interface KindInfo {
  /** Accessible name of the icon. */
  label: string;
  /** Heading of the `<optgroup>` / picker group the kind belongs to. */
  group: string;
  /** Unicode glyph for places SVG cannot go; `#` for text, as Discord does. */
  glyph: string;
  /** Children of the 24x24 Lucide `svg` (ISC licence, copied from lucide-static). */
  icon: string;
}

const KINDS: Record<ChannelKind, KindInfo> = {
  text: {
    label: "Text channel",
    group: "Text Channels",
    glyph: "#",
    icon:
      `<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/>` +
      `<line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>`,
  },
  announcement: {
    label: "Announcement channel",
    group: "Text Channels",
    glyph: "📢",
    icon:
      `<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>` +
      `<path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>`,
  },
  voice: {
    label: "Voice channel",
    group: "Voice Channels",
    glyph: "🔊",
    icon:
      `<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>` +
      `<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>`,
  },
  stage: {
    label: "Stage channel",
    group: "Voice Channels",
    glyph: "🎙️",
    icon:
      `<path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"/>` +
      `<path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"/>` +
      `<circle cx="16" cy="7" r="5"/>`,
  },
  forum: {
    label: "Forum channel",
    group: "Forum Channels",
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

const ALERT_ICON =
  `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>` +
  `<path d="M12 9v4"/><path d="M12 17h.01"/>`;

function svg(children: string, label: string): string {
  return `<svg class="kb-icon" viewBox="0 0 24 24" role="img" aria-label="${escapeHtml(label)}" focusable="false">${children}</svg>`;
}

/** Heading of the `<optgroup>` / picker group a channel kind is listed under. */
export function channelGroupLabel(type: ChannelType | number): string {
  const kind = channelKindOf(type);
  return kind ? KINDS[kind].group : "Other";
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
  if (!kind) return missingMention(ref.name);
  const info = KINDS[kind];
  const cls =
    kind === "category" ? "kb-mention kb-mention--category" : "kb-mention";
  return `<span class="${cls}">${svg(info.icon, info.label)}${escapeHtml(ref.name)}</span>`;
}

/** A role as a `kb-mention`: `@Name`, no icon, as Discord shows it. */
export function roleMention(name: string): string {
  return `<span class="kb-mention">@${escapeHtml(name)}</span>`;
}

/** An id that no longer resolves to anything: an alert icon and "(unavailable)". */
export function missingMention(id: string): string {
  return `<span class="kb-mention kb-mention--missing">${svg(ALERT_ICON, "Unavailable")}${escapeHtml(id)} (unavailable)</span>`;
}

// ---- plain text ------------------------------------------------------------

/**
 * A channel as plain text (not escaped): `# general`, `🔊 Lobby`, `📁 Events`.
 * `parentName` adds the category the way Discord's autocomplete shows it
 * (`🔊 Lobby · Scratch`). Unknown type: `⚠ <name> (unavailable)`.
 */
export function channelText(ref: ChannelRef, parentName?: string): string {
  const kind = channelKindOf(ref.type);
  if (!kind) return missingText(ref.name);
  const head = `${KINDS[kind].glyph} ${ref.name}`;
  return parentName && kind !== "category" ? `${head} · ${parentName}` : head;
}

/** A role as plain text (not escaped): `@Moderators`. */
export function roleText(name: string): string {
  return `@${name}`;
}

/** An unresolved id as plain text (not escaped): `⚠ 1234 (unavailable)`. */
export function missingText(id: string): string {
  return `⚠ ${id} (unavailable)`;
}
