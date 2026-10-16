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

/** A Unicode emoji or a custom emoji in `<:name:id>` / `<a:name:id>` form. */
export function isValidPickerEmoji(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  if (/^<a?:\w{2,32}:\d{15,25}>$/.test(v)) return true;
  // Keycaps and flags are emoji sequences without Extended_Pictographic bases.
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3|\u200D|\uFE0F|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])+$/u.test(
    v,
  );
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
export function detectRolePairings(
  scan: Pick<ServerScan, "guildId" | "channels" | "roles" | "scanned">,
  groups: readonly GroupSpec[],
): RolePairing[] {
  const roles = new Map(scan.roles.map((r) => [r.id, r]));
  const rawRoles = new Map(scan.scanned.roles.map((r) => [r.id, r]));
  const groupBacked = new Map(
    groups.flatMap((g) => (g.roleId ? [[g.roleId, g.name] as const] : [])),
  );
  // What each role's own overwrites allow, on ANY channel: the dangerous bits
  // are just as exploitable on an unsynced child as on the category. The scan
  // already holds every channel's overwrites, so this is one in-memory pass.
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
    const role = roles.get(gates[0].id);
    const raw = rawRoles.get(gates[0].id);
    if (!role || !raw) continue;
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
    out.push({
      categoryId: c.id,
      categoryName: c.name,
      roleId: role.id,
      roleName: role.name,
      state,
      reason,
    });
  }
  return out;
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
