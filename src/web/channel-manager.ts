/**
 * Channel Manager rules (#1065): Discord's structural limits, input
 * validation, the tree shown on the page, and the "who owns this channel"
 * protection map that decides what may be deleted.
 *
 * Everything here is pure (no Discord client, no database) so the limits and
 * the refusal rules are unit-tested directly. `channel-manager-data.ts` reads
 * the live guild and the stores that feed these functions.
 */

import { createHash } from "node:crypto";

/** Discord's documented limits for the structure this page edits. */
export const CHANNEL_LIMITS = {
  /** Channels per server, categories included (threads excluded). */
  guildChannels: 500,
  /** Channels inside one category. */
  perCategory: 50,
  nameMax: 100,
  topicMax: 1024,
  /** Voice user limit; 0 means no limit. */
  userLimitMax: 99,
  /** Lowest voice bitrate Discord accepts, in bits per second. */
  bitrateMin: 8000,
  /** Highest voice bitrate when the server's boost tier is unknown. */
  bitrateDefaultMax: 96000,
} as const;

export type ManageableKind = "text" | "voice" | "category";
export type ChannelKind = ManageableKind | "other";

export interface ManagedChannelView {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Discord's own name for the channel type, shown for `other` channels. */
  typeLabel: string;
  parentId: string | null;
  position: number;
  topic: string | null;
  userLimit: number | null;
  /** Bits per second. */
  bitrate: number | null;
}

export interface CategoryNode {
  category: ManagedChannelView;
  children: ManagedChannelView[];
}

export interface ChannelTree {
  categories: CategoryNode[];
  uncategorized: ManagedChannelView[];
  /** Every channel counted against the 500 limit. */
  total: number;
}

const SNOWFLAKE = /^\d{15,25}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

/** A stage channel: not managed here, but it sorts with the voice channels. */
function isStage(c: ManagedChannelView): boolean {
  return c.kind === "other" && c.typeLabel === "GuildStageVoice";
}

/**
 * Text-like channels (and unsupported types) list above voice and stage
 * channels, as Discord displays them; reordering also treats stage channels as
 * voice siblings.
 */
function groupOf(c: ManagedChannelView): number {
  return c.kind === "voice" || isStage(c) ? 1 : 0;
}

function byOrder(a: ManagedChannelView, b: ManagedChannelView): number {
  return (
    groupOf(a) - groupOf(b) ||
    a.position - b.position ||
    a.id.localeCompare(b.id)
  );
}

export function buildChannelTree(
  channels: readonly ManagedChannelView[],
): ChannelTree {
  const categories = channels
    .filter((c) => c.kind === "category")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const known = new Set(categories.map((c) => c.id));
  const rest = channels.filter((c) => c.kind !== "category");
  return {
    categories: categories.map((category) => ({
      category,
      children: rest.filter((c) => c.parentId === category.id).sort(byOrder),
    })),
    uncategorized: rest
      .filter((c) => c.parentId === null || !known.has(c.parentId))
      .sort(byOrder),
    total: channels.length,
  };
}

/**
 * The channels a move up/down swaps between: other categories for a category,
 * otherwise the same-parent channels of the same text/voice group (Discord
 * orders those separately).
 */
export function siblingsOf(
  channels: readonly ManagedChannelView[],
  target: ManagedChannelView,
): ManagedChannelView[] {
  const list =
    target.kind === "category"
      ? channels.filter((c) => c.kind === "category")
      : channels.filter(
          (c) =>
            c.kind !== "category" &&
            c.parentId === target.parentId &&
            groupOf(c) === groupOf(target),
        );
  return list.sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

/** The sibling a one-step move in `direction` swaps with, or null at the edge. */
export function neighbourOf(
  channels: readonly ManagedChannelView[],
  target: ManagedChannelView,
  direction: "up" | "down",
): ManagedChannelView | null {
  const siblings = siblingsOf(channels, target);
  const at = siblings.findIndex((c) => c.id === target.id);
  if (at < 0) return null;
  return siblings[direction === "up" ? at - 1 : at + 1] ?? null;
}

/** Whether the channel can move one step in `direction` among its siblings. */
export function canMove(
  channels: readonly ManagedChannelView[],
  target: ManagedChannelView,
  direction: "up" | "down",
): boolean {
  const siblings = siblingsOf(channels, target);
  const at = siblings.findIndex((c) => c.id === target.id);
  if (at < 0) return false;
  return direction === "up" ? at > 0 : at < siblings.length - 1;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

// U+200C/U+200D (zero-width non-joiner/joiner) are deliberately not listed:
// compound emoji such as family and flag sequences are built from them.
/* eslint-disable no-control-regex */
const NAME_STRIP =
  /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e]+/g;
/* eslint-enable no-control-regex */

/** Control characters and line breaks removed, runs of spaces collapsed. */
export function cleanName(raw: unknown): string {
  return String(raw ?? "")
    .replace(NAME_STRIP, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateName(raw: unknown, what = "name"): Checked<string> {
  const value = cleanName(raw);
  if (value.length === 0) return fail(`Give the ${what} a name.`);
  if (value.length > CHANNEL_LIMITS.nameMax) {
    return fail(
      `The ${what} is ${value.length} characters; Discord allows at most ${CHANNEL_LIMITS.nameMax}.`,
    );
  }
  return { ok: true, value };
}

export function validateTopic(raw: unknown): Checked<string> {
  // Keep line breaks (a topic may span lines); drop other control characters.
  const value = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, "")
    .trim();
  if (value.length > CHANNEL_LIMITS.topicMax) {
    return fail(
      `The topic is ${value.length} characters; Discord allows at most ${CHANNEL_LIMITS.topicMax}.`,
    );
  }
  return { ok: true, value };
}

/** Empty means "no limit" (0). */
export function validateUserLimit(raw: unknown): Checked<number> {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, value: 0 };
  if (!/^\d+$/.test(text)) {
    return fail("The user limit must be a whole number from 0 to 99.");
  }
  const value = Number(text);
  if (value > CHANNEL_LIMITS.userLimitMax) {
    return fail(
      `The user limit can be at most ${CHANNEL_LIMITS.userLimitMax} (0 means no limit).`,
    );
  }
  return { ok: true, value };
}

/**
 * The form takes kilobits per second; Discord wants bits per second. Empty
 * means "leave it at Discord's default" (undefined).
 */
export function validateBitrateKbps(
  raw: unknown,
  maxBps: number,
): Checked<number | undefined> {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, value: undefined };
  const minKbps = CHANNEL_LIMITS.bitrateMin / 1000;
  const maxKbps = Math.floor(maxBps / 1000);
  if (!/^\d+$/.test(text)) {
    return fail(
      `The bitrate must be a whole number of kbps from ${minKbps} to ${maxKbps}.`,
    );
  }
  const kbps = Number(text);
  if (kbps < minKbps || kbps > maxKbps) {
    return fail(
      `The bitrate must be from ${minKbps} to ${maxKbps} kbps for this server (its boost level sets the upper limit).`,
    );
  }
  return { ok: true, value: kbps * 1000 };
}

/**
 * Whether one more channel fits: in the server as a whole and, when `parentId`
 * is set, in that category. `movingWithin` is the category the channel is
 * already in (a no-op move does not need room).
 */
export function checkCapacity(
  channels: readonly ManagedChannelView[],
  opts: {
    parentId: string | null;
    /** Creating adds to the server total; moving does not. */
    creating: boolean;
    movingFrom?: string | null;
  },
): Checked<true> {
  if (opts.creating && channels.length >= CHANNEL_LIMITS.guildChannels) {
    return fail(
      `This server already has ${channels.length} channels and categories; Discord's limit is ${CHANNEL_LIMITS.guildChannels}.`,
    );
  }
  if (opts.parentId && opts.parentId !== opts.movingFrom) {
    const inside = channels.filter(
      (c) => c.kind !== "category" && c.parentId === opts.parentId,
    ).length;
    if (inside >= CHANNEL_LIMITS.perCategory) {
      return fail(
        `That category already holds ${inside} channels; Discord allows ${CHANNEL_LIMITS.perCategory} per category.`,
      );
    }
  }
  return { ok: true, value: true };
}

/** Resolve a posted parent id to an existing category (or "no category"). */
export function resolveParent(
  channels: readonly ManagedChannelView[],
  raw: unknown,
): Checked<string | null> {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, value: null };
  if (!isSnowflake(text)) return fail("Pick a category from the list.");
  const parent = channels.find((c) => c.id === text);
  if (!parent || parent.kind !== "category") {
    return fail("That category doesn't exist on this server any more.");
  }
  return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// Protection: channels the bot itself manages
// ---------------------------------------------------------------------------

export interface ProtectionInputs {
  /** Effective config: stored value, else env, else schema default. */
  config: Record<string, unknown>;
  /** Rows of `ManagedVoiceChannel` (temporary channels, waiting rooms, lobby). */
  managedVoice: ReadonlyArray<{ channelId: string; kind: string }>;
  /** Ids from `VoiceChannelOwnership` (a member owns this temporary channel). */
  ownedVoiceIds: readonly string[];
  /** Support tickets of any status: closed ones are archived, not gone. */
  tickets: ReadonlyArray<{ id: string; channelId: string }>;
  /** Events that have not ended or been cancelled. */
  events: ReadonlyArray<{
    id: string;
    channelId: string | null;
    categoryId: string;
    announcementChannelId: string | null;
  }>;
  /** Open looking-for-group posts. */
  lfg: ReadonlyArray<{ voiceChannelId: string | null; channelId: string }>;
  /**
   * Channels the voice service holds as its own in memory (rooms, waiting
   * rooms, writes still pending), each with the reason to show.
   */
  voiceInMemory: ReadonlyArray<{ channelId: string; reason: string }>;
  /** Reaction-role mappings that have not been archived. */
  reactionRoles: ReadonlyArray<{
    id: string;
    channelId: string | null;
    categoryId: string | null;
  }>;
  /** Poll schedules, enabled or not (a disabled one can be turned back on). */
  pollSchedules: ReadonlyArray<{ id: string; channelId: string }>;
  /** Scheduled announcements, enabled or not. */
  announcements: ReadonlyArray<{ id: string; channelId: string }>;
  /** Channels Discord itself points at (community and system channels). */
  discord: { label: string; channelId: string | null }[];
  /**
   * Every name the voice service may treat as the lobby or offline lobby
   * (`resolveLobbyChannelName` / `resolveOfflineLobbyNames`: quotes removed,
   * legacy keys and defaults applied).
   */
  lobbyNames: readonly string[];
  /**
   * The voice service's own test for the legacy join-to-create trigger name
   * (`isNewChannelTriggerName`), passed in so there is one definition.
   */
  isTriggerName: (name: string) => boolean;
  /** The live channels, for finding the lobby by name. */
  channels: readonly ManagedChannelView[];
}

/** Config keys that bind a channel or category (the issue's `*_id` settings). */
export const BINDING_KEY = /(channel_id|category_id)$/;

function ids(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(isSnowflake);
}

/**
 * Channel id -> the reasons KoolBot manages it, each naming the setting or
 * feature, e.g. `the quotes.channel_id setting`.
 */
export function buildProtectionMap(
  input: ProtectionInputs,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (id: string | null | undefined, reason: string): void => {
    if (!id) return;
    const list = map.get(id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    map.set(id, list);
  };

  for (const [key, value] of Object.entries(input.config)) {
    if (!BINDING_KEY.test(key)) continue;
    for (const id of ids(value)) add(id, `the ${key} setting`);
  }

  for (const row of input.managedVoice) {
    const what =
      row.kind === "lobby"
        ? "the voice lobby"
        : row.kind === "waiting_room"
          ? "a waiting room for a temporary voice channel"
          : "a temporary voice channel";
    add(row.channelId, `${what} (managed by Voice Channels)`);
  }
  for (const id of input.ownedVoiceIds) {
    add(id, "a temporary voice channel (managed by Voice Channels)");
  }
  for (const t of input.tickets) {
    add(t.channelId, `a support ticket channel (Tickets, ticket ${t.id})`);
  }
  for (const e of input.events) {
    add(e.channelId, "an active event's voice channel (Events)");
    add(e.announcementChannelId, "an event announcement channel (Events)");
    for (const id of ids(e.categoryId)) {
      add(id, "an event's category (Events)");
    }
  }
  for (const l of input.lfg) {
    add(l.voiceChannelId, "a looking-for-group voice channel (LFG)");
    add(l.channelId, "a looking-for-group post channel (LFG)");
  }
  for (const r of input.reactionRoles) {
    add(
      r.channelId,
      `a reaction role's private channel (Reaction Roles, mapping ${r.id})`,
    );
    add(
      r.categoryId,
      `a reaction role's private category (Reaction Roles, mapping ${r.id})`,
    );
  }
  for (const p of input.pollSchedules) {
    add(p.channelId, `a poll schedule's channel (Polls, schedule ${p.id})`);
  }
  for (const a of input.announcements) {
    add(
      a.channelId,
      `a scheduled announcement's channel (Announcements, announcement ${a.id})`,
    );
  }
  for (const v of input.voiceInMemory) add(v.channelId, v.reason);
  for (const d of input.discord) add(d.channelId, d.label);

  // The voice lobby. VoiceChannelManager only trusts a configured lobby id
  // while it is a voice channel inside the managed category; otherwise (a stale
  // id pointing at a text channel or at a channel outside the category) it
  // falls back to finding the lobby by name, and the offline lobby is always
  // found by name. A configured id therefore never lets us skip the name
  // check: voice channels named like the lobby or offline lobby inside the
  // voice category stay protected whatever the id says. When the category
  // isn't set, any voice channel with those names is protected. Over-protecting
  // is the safe side, and the service's exact-match rule is a subset of this
  // trimmed, case-insensitive one.
  const category = ids(input.config["voicechannels.category_id"])[0];
  const names = input.lobbyNames
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  for (const c of input.channels) {
    // The legacy join-to-create trigger is identified by name alone, anywhere
    // in the server, exactly as the voice service does.
    if (c.kind === "voice" && input.isTriggerName(c.name)) {
      add(
        c.id,
        'the legacy "New Channel" join-to-create trigger (Voice Channels)',
      );
    }
    if (c.kind !== "voice" && !isStage(c)) continue;
    if (category && c.parentId !== category) continue;
    if (names.includes(c.name.trim().toLowerCase())) {
      add(
        c.id,
        "the voice lobby, found by name (voicechannels.lobby.name / voicechannels.lobby.offlinename)",
      );
    }
  }
  return map;
}

export type DeleteVerdict =
  { ok: true } | { ok: false; message: string; reasons: string[] };

/**
 * May this channel or category be deleted? Managed channels are refused with
 * a message naming why. A category must be empty: deleting a populated one
 * drops its channels to the top level, which silently breaks features that
 * look for their channels under a category.
 */
export function deleteVerdict(
  target: ManagedChannelView,
  channels: readonly ManagedChannelView[],
  protection: ReadonlyMap<string, string[]>,
): DeleteVerdict {
  const own = protection.get(target.id) ?? [];
  if (own.length > 0) {
    return {
      ok: false,
      reasons: own,
      message: `KoolBot manages "${target.name}": it is ${own.join("; ")}. Change that in Settings first, then delete the channel in Discord if you still want it gone.`,
    };
  }
  if (target.kind === "category") {
    const children = channels.filter((c) => c.parentId === target.id);
    if (children.length > 0) {
      const managed = children.flatMap((c) =>
        protection.has(c.id) ? [c.name] : [],
      );
      return {
        ok: false,
        reasons: [],
        message:
          `"${target.name}" still holds ${children.length} channel${children.length === 1 ? "" : "s"}` +
          (managed.length > 0
            ? `, including ones KoolBot manages (${managed.join(", ")})`
            : "") +
          ". Move or delete them first; deleting a category would drop its channels to the top level.",
      };
    }
  }
  return { ok: true };
}

/**
 * Binds a delete confirmation to the channel as the admin saw it: its id, type,
 * name and parent, and for a category the channels inside it. The confirmation
 * page carries this in its `confirm` field and the delete re-computes it from
 * the live server, so a channel renamed, moved or (for a category) emptied or
 * filled after the page was shown must be confirmed again.
 */
export function confirmationToken(
  target: ManagedChannelView,
  channels: readonly ManagedChannelView[],
): string {
  const children =
    target.kind === "category"
      ? channels
          .filter((c) => c.parentId === target.id)
          .map((c) => c.id)
          .sort()
      : [];
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.id,
        target.kind,
        target.name,
        target.parentId,
        children,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}
