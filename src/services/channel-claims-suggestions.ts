import { PermissionFlagsBits } from "discord.js";
import { forbiddenSelfAssignNames } from "../utils/role-safety.js";
import type { GroupSpec } from "./role-group-plan.js";
import type { ScanWebhooks, ServerScan } from "./server-scan-service.js";

/**
 * Pure detection for the suggestions on the claims page (#1022): which
 * categories are already gated by exactly one role (a game-role pairing), and
 * which channels are fed by webhooks or followed announcement channels. No
 * Discord or database access; the scan is the only input.
 */

/** Emoji for a pairing's picker when the admin doesn't pick one. */
export const DEFAULT_PAIR_EMOJI = "🎮";

/**
 * Exactly one emoji: a custom emoji in `<:name:id>` / `<a:name:id>` form, or ONE
 * Unicode grapheme that is an emoji sequence (a pictograph with an optional
 * skin tone or variation selector, joined with ZWJ, a flag, a keycap or a tag
 * sequence). Several emoji ("🎮🎯") or stray joiners and selectors are refused:
 * Discord can't react with them and the picker would fail after being posted.
 */
const EMOJI_SEQUENCE =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$/u;

export function isValidPickerEmoji(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  if (/^<a?:\w{2,32}:\d{15,25}>$/.test(v)) return true;
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v),
  ];
  return graphemes.length === 1 && EMOJI_SEQUENCE.test(v);
}

export type PairingState =
  /** Can be registered. */
  | "proposed"
  /** Detected, but the role can't be a self-assign role: `reason` says why. */
  | "refused"
  /** The role is already a reaction role: nothing to do. */
  | "registered";

export interface RolePairing {
  categoryId: string;
  categoryName: string;
  roleId: string;
  roleName: string;
  state: PairingState;
  reason: string | null;
}

/**
 * Categories whose overwrites follow "@everyone ViewChannel denied plus exactly
 * one role allowed". The count ignores other bots' integration roles and
 * KoolBot's own role (they sit on many categories without being the gate) and
 * member overwrites, but not a managed non-bot role such as Server Booster:
 * that makes the category ambiguous, so it is not proposed.
 *
 * A detected role that can't safely be self-assigned is returned as `refused`
 * with the reason, never hidden.
 */
type PairingScan = Pick<
  ServerScan,
  "guildId" | "channels" | "roles" | "scanned"
>;

/** What each role's own overwrites allow on ANY channel (dangerous bits only). */
function dangerousGrants(
  scan: PairingScan,
): Map<string, { channel: string; names: string[] }> {
  // The dangerous bits are just as exploitable on an unsynced child as on the
  // category. The scan already holds every channel's overwrites, so this is one
  // in-memory pass.
  const grants = new Map<string, { channel: string; names: string[] }>();
  for (const ch of scan.channels) {
    for (const o of ch.overwrites) {
      if (o.type !== "role" || grants.has(o.id)) continue;
      const bits = (o.allow as string[]).reduce(
        (acc, name) =>
          acc |
          (PermissionFlagsBits[name as keyof typeof PermissionFlagsBits] ?? 0n),
        0n,
      );
      const names = forbiddenSelfAssignNames(bits);
      if (names.length > 0) grants.set(o.id, { channel: ch.name, names });
    }
  }
  return grants;
}

/** The safety verdict for pairing `roleId` with `categoryId`. */
function judgePairing(
  scan: PairingScan,
  groups: readonly GroupSpec[],
  grants: ReturnType<typeof dangerousGrants>,
  categoryId: string,
  roleId: string,
  claimedRoles: Map<string, string>,
): RolePairing | null {
  const c = scan.channels.find((x) => x.id === categoryId);
  const role = scan.roles.find((r) => r.id === roleId);
  const raw = scan.scanned.roles.find((r) => r.id === roleId);
  if (!c || c.kind !== "category" || !role || !raw) return null;
  const groupBacked = new Map(
    groups.flatMap((g) => (g.roleId ? [[g.roleId, g.name] as const] : [])),
  );
  const dangerous = forbiddenSelfAssignNames(BigInt(raw.permissions));
  const overwriteGrant = grants.get(role.id);
  let state: PairingState = "proposed";
  let reason: string | null = null;
  if (role.managed) {
    state = "refused";
    reason = `@${role.name} is managed by an integration and can't be handed out.`;
  } else if (groupBacked.has(role.id)) {
    state = "refused";
    reason = `@${role.name} backs the role group "${groupBacked.get(role.id)}"; manage it through the group.`;
  } else if (dangerous.length > 0) {
    state = "refused";
    reason = `@${role.name} has powerful permissions (${dangerous.join(", ")}), so any member could pick it up. Remove those permissions from the role first.`;
  } else if (overwriteGrant) {
    state = "refused";
    reason = `"${overwriteGrant.channel}" gives @${role.name} powerful permissions in its own overwrite (${overwriteGrant.names.join(", ")}), so anyone who picks the role would get them there. Remove them from that channel first.`;
  } else if (raw.position >= scan.scanned.botHighestRolePosition) {
    state = "refused";
    reason = `@${role.name} sits at or above KoolBot's highest role, so KoolBot can't assign it.`;
  } else if (role.usedBy.includes("reactionroles")) {
    state = "registered";
    reason = `@${role.name} is already a reaction role.`;
  } else if (claimedRoles.has(role.id)) {
    state = "refused";
    reason = `@${role.name} already gates "${claimedRoles.get(role.id)}"; a role is registered once.`;
  }
  if (state === "proposed") claimedRoles.set(role.id, c.name);
  return {
    categoryId: c.id,
    categoryName: c.name,
    roleId: role.id,
    roleName: role.name,
    state,
    reason,
  };
}

export function detectRolePairings(
  scan: PairingScan,
  groups: readonly GroupSpec[],
): RolePairing[] {
  const roles = new Map(scan.roles.map((r) => [r.id, r]));
  const grants = dangerousGrants(scan);
  const out: RolePairing[] = [];
  const claimedRoles = new Map<string, string>();
  for (const c of scan.channels) {
    if (c.kind !== "category") continue;
    const everyone = c.overwrites.find((o) => o.id === scan.guildId);
    if (!everyone?.deny.includes("ViewChannel")) continue;
    const gates = c.overwrites.filter(
      (o) =>
        o.type === "role" &&
        o.id !== scan.guildId &&
        o.allow.includes("ViewChannel") &&
        // Only integration roles (another bot's, or KoolBot's own) are left out.
        // An ordinary role KoolBot happens to hold still counts as a gate.
        roles.get(o.id)?.botId === null,
    );
    if (gates.length !== 1) continue;
    const verdict = judgePairing(
      scan,
      groups,
      grants,
      c.id,
      gates[0].id,
      claimedRoles,
    );
    if (verdict) out.push(verdict);
  }
  return out;
}

/**
 * Pairings for steps that were already planned: the role and the category are
 * the ones the plan recorded, judged again against the live server (role
 * safety, overwrites on every channel) but NOT required to still be "gated by
 * exactly one role": a plan that also gates the category for another role must
 * be able to resume its registration after that gate has been applied.
 */
export function judgeRecordedPairings(
  scan: PairingScan,
  groups: readonly GroupSpec[],
  recorded: ReadonlyArray<{ categoryId: string; roleId: string }>,
): RolePairing[] {
  const grants = dangerousGrants(scan);
  const claimedRoles = new Map<string, string>();
  return recorded.flatMap((r) => {
    const verdict = judgePairing(
      scan,
      groups,
      grants,
      r.categoryId,
      r.roleId,
      claimedRoles,
    );
    return verdict ? [verdict] : [];
  });
}

export type FeedKind = "incoming" | "channel-follower";

export interface FeedChannel {
  channelId: string;
  kinds: FeedKind[];
}

export interface FeedDetection {
  /** False when the webhook list couldn't be read: nothing is suggested. */
  known: boolean;
  unavailable: ScanWebhooks["unavailable"];
  feeds: FeedChannel[];
}

/**
 * Text and announcement channels fed by an incoming webhook or a followed
 * announcement channel, from the scan's webhook list. Application webhooks
 * (interaction replies) are not feeds. When the list is unknown (no Manage
 * Webhooks), nothing is guessed: `feeds` is empty and `known` is false so the
 * page can say the data is unavailable instead of "there are none".
 */
export function detectFeeds(
  scan: Pick<ServerScan, "channels" | "webhooks">,
): FeedDetection {
  if (!scan.webhooks.known) {
    return { known: false, unavailable: scan.webhooks.unavailable, feeds: [] };
  }
  const byChannel = new Map<string, Set<FeedKind>>();
  for (const h of scan.webhooks.list) {
    if (h.kind !== "incoming" && h.kind !== "channel-follower") continue;
    const set = byChannel.get(h.channelId) ?? new Set<FeedKind>();
    set.add(h.kind);
    byChannel.set(h.channelId, set);
  }
  const feeds: FeedChannel[] = [];
  for (const c of scan.channels) {
    const kinds = byChannel.get(c.id);
    if (!kinds || c.kind !== "text" || c.flags.forum) continue;
    feeds.push({ channelId: c.id, kinds: [...kinds] });
  }
  return { known: true, unavailable: null, feeds };
}
