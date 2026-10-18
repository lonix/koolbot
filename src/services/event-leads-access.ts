/**
 * Who may see and connect to an event's leads channel (#1199): the pure rules,
 * with no database and no Discord call, so every one of them is a plain test.
 *
 * The channel is `leads` kind: a command channel for the leaders of the event's
 * team groups and the host. The rules, in one place:
 *
 * - **@everyone** is denied Connect. View is allowed so people can see that the
 *   channel exists, unless the events category already denies @everyone View
 *   (a private category stays private, #1213): that deny is never lifted.
 * - **The host** (the event creator) gets View, Connect, Speak and Move Members
 *   (Move Members is what every group channel already gives the host, #1213).
 * - **Every current leader** (`effectiveLeaders`) gets View, Connect and Speak.
 * - **The bot** gets View, Connect and Move Members. Its own entry is not
 *   decoration: with @everyone denied Connect, a bot that only has Connect
 *   from its server role could not connect, so it could not move anyone in.
 * - **Admins** are never denied. Nothing here adds a deny bit for anyone but
 *   @everyone, and an admin role is left exactly as it is: a role holding
 *   Administrator (it bypasses overwrites anyway) and the role of a KoolBot
 *   admin group (the Web UI's admins, who may act as host).
 * - **Roles that would defeat the deny.** Discord applies a role's allow after
 *   @everyone's deny, so a role overwrite copied from the category that allows
 *   Connect would let every holder in. On every pass
 *   (creation and each later sync: an earlier clean-up cannot be told from the
 *   channel) the Connect and Speak ALLOW bits are removed from every role
 *   entry other than an admin role (Administrator, or the role of a KoolBot
 *   admin group; when those cannot be read no role is touched). Only allow
 *   bits are removed; the role then has no say and falls under the @everyone
 *   deny. The role of each KoolBot admin group is given an explicit View,
 *   Connect and Speak allow instead (their holders may have Connect only from
 *   server permissions, which the deny overrides), never lifting a deny the
 *   category already has.
 * - **Other members.** A member overwrite for anyone who is not the host, the
 *   bot or a current leader loses the View, Connect and Speak allow bits the
 *   bot would have granted (a leader who lost the role, a member data reset,
 *   a hand-made entry); the entry is deleted when nothing is left in it. A
 *   pure deny entry is never touched.
 */

import { OverwriteType, PermissionFlagsBits } from "discord.js";
import {
  effectiveLeaders,
  resolveLeadsChannel,
  type LeaderGroup,
} from "./event-leader-roles.js";
import type { MovePlan, MoveWish } from "./event-member-moves.js";

export interface OverwriteSpec {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

const VIEW = PermissionFlagsBits.ViewChannel;
const CONNECT = PermissionFlagsBits.Connect;
const SPEAK = PermissionFlagsBits.Speak;
const MOVE = PermissionFlagsBits.MoveMembers;

/** What a leader gets in the leads channel. */
export const LEADS_LEADER_PERMISSIONS = VIEW | CONNECT | SPEAK;
/** What the host gets: the leader's, plus Move Members as on every group channel. */
export const LEADS_HOST_PERMISSIONS = VIEW | CONNECT | SPEAK | MOVE;
/** What the bot gets: it moves people in and out. */
export const LEADS_BOT_PERMISSIONS = VIEW | CONNECT | MOVE;
/** What the bot must itself hold to be allowed to grant the above (Discord refuses otherwise). */
export const LEADS_REQUIRED_BOT_PERMISSIONS =
  LEADS_HOST_PERMISSIONS | PermissionFlagsBits.ManageRoles;
/** The allow bits that make a channel joinable or audible; a role must not keep them. */
const OPEN_BITS = CONNECT | SPEAK;

/**
 * The leaders who get access: the event's effective leaders, and none while the
 * event's leaders switch is off (a leader kept with the switch off is hidden
 * everywhere else too, #1195).
 */
export function leadsLeaderIds(event: {
  captainsEnabled?: boolean;
  groups?: readonly LeaderGroup[] | null;
}): string[] {
  if (event.captainsEnabled !== true) return [];
  return effectiveLeaders(event.groups).map((l) => l.userId);
}

export interface LeadsAccessContext {
  /** The guild id, which is also the @everyone role's id. */
  everyoneId: string;
  /** The event creator, or null when it is not a Discord user. */
  hostId: string | null;
  /** The bot's user id, or null when unknown. */
  botId: string | null;
  /** The current leaders (`effectiveLeaders`), by user id. */
  leaderIds: readonly string[];
  /**
   * Admin roles, whose entries are left as they are: roles holding
   * Administrator and the roles of KoolBot's admin groups (the Web UI admins).
   */
  adminRoleIds?: ReadonlySet<string>;
  /**
   * The admin roles could not be established: no role entry is touched (an
   * admin must never be denied by a guess).
   */
  allRolesExempt?: boolean;
  /**
   * The roles of KoolBot's admin groups: they get an explicit allow (View,
   * Connect, Speak) because the @everyone deny would otherwise lock out admins
   * whose Connect comes only from their server permissions. Empty while the
   * admin groups are unknown (nothing is guessed).
   */
  adminGrantRoleIds?: ReadonlySet<string>;
  /**
   * The events category's own overwrites, read fresh. A sync plan never grants
   * View where the category denies it (to @everyone, or to the role being
   * granted): the channel's own entries do not show that (a degraded channel
   * may have lost the deny). Creation starts from a copy of them instead.
   */
  categoryOverwrites?: readonly OverwriteSpec[];
  /**
   * The category could not be read: no View is granted to anyone (nothing is
   * exposed on a guess).
   */
  categoryUnknown?: boolean;
}

const keyOf = (o: { type: OverwriteType; id: string }): string =>
  `${o.type}:${o.id}`;

/** The members that must have access, and exactly which bits each needs. */
export function desiredMembers(ctx: LeadsAccessContext): Map<string, bigint> {
  const want = new Map<string, bigint>();
  const add = (id: string | null, bits: bigint): void => {
    if (!id) return;
    want.set(id, (want.get(id) ?? 0n) | bits);
  };
  add(ctx.hostId, LEADS_HOST_PERMISSIONS);
  add(ctx.botId, LEADS_BOT_PERMISSIONS);
  for (const id of ctx.leaderIds) add(id, LEADS_LEADER_PERMISSIONS);
  return want;
}

/** @everyone: Connect denied; View allowed unless the category already denies it. */
function restrictEveryone(
  current: OverwriteSpec | undefined,
  everyoneId: string,
  viewBlocked = false,
  enforceViewDeny = false,
): OverwriteSpec {
  let deny = (current?.deny ?? 0n) | CONNECT;
  let allow = (current?.allow ?? 0n) & ~CONNECT;
  // The category hides channels from @everyone: this channel has its own copy
  // of the overwrites, so a later change of the category is enforced here, and
  // a View allow that contradicts it goes.
  if (enforceViewDeny) {
    deny |= VIEW;
    allow &= ~VIEW;
  }
  if ((deny & VIEW) === 0n && !viewBlocked) allow |= VIEW;
  return { id: everyoneId, type: OverwriteType.Role, allow, deny };
}

/** What the one role rule needs to know besides the two entries. */
interface RoleFacts {
  /** The role of a KoolBot admin group: it is given its own access. */
  grant: boolean;
  /** The category denies View to @everyone. */
  categoryDeniesView: boolean;
  /** View may not be added on the bot's own account: @everyone's View is denied
   * (by the category or the channel) or the category is unknown. */
  viewBlocked: boolean;
}

/**
 * THE ONE RULE for the entry of any role (not @everyone), used identically at
 * creation, in the sync pass and in the cache trigger (which runs the pass's
 * planner), so they cannot disagree:
 *
 * - **Connect and Speak.** An ordinary role never keeps them as an allow (a
 *   role's allow applies after @everyone's deny and would let its holders in);
 *   an admin group's role is given them.
 * - **View** is derived from the category's own entry for THAT role:
 *   the category denies it, so the channel denies it and holds no allow; the
 *   category allows it, so the channel allows it (kept or added, also when the
 *   role has no entry yet); the category has no View entry for the role, so the
 *   channel keeps only what was there before, except that it is taken away when
 *   the category hides channels from @everyone (a channel-level allow would
 *   show the channel to people who cannot see the category), and an admin
 *   group's role is given it only while @everyone's View is not denied.
 * - **Denies.** A deny the channel already has stays. The category's View deny
 *   is copied, and for an admin group's role also its Connect and Speak deny.
 *   Nothing else is ever denied here.
 *
 * Returns null when the role needs no entry at all.
 */
function desiredRoleEntry(
  id: string,
  current: OverwriteSpec | undefined,
  category: OverwriteSpec | undefined,
  facts: RoleFacts,
): OverwriteSpec | null {
  const categoryDeny = category?.deny ?? 0n;
  const categoryAllow = category?.allow ?? 0n;
  const deny =
    (current?.deny ?? 0n) |
    (categoryDeny & (facts.grant ? VIEW | CONNECT | SPEAK : VIEW));
  let allow = (current?.allow ?? 0n) & ~deny;
  if (!facts.grant) allow &= ~OPEN_BITS;
  if ((deny & VIEW) === 0n) {
    if ((categoryAllow & VIEW) !== 0n) allow |= VIEW;
    else if (facts.categoryDeniesView) allow &= ~VIEW;
    else if (facts.grant && !facts.viewBlocked) allow |= VIEW;
  }
  if (facts.grant) allow |= (CONNECT | SPEAK) & ~deny;
  if (allow === 0n && deny === 0n) return null;
  return { id, type: OverwriteType.Role, allow, deny };
}

function widen(
  current: OverwriteSpec | undefined,
  id: string,
  bits: bigint,
): OverwriteSpec {
  return {
    id,
    type: OverwriteType.Member,
    allow: (current?.allow ?? 0n) | bits,
    deny: (current?.deny ?? 0n) & ~bits,
  };
}

const isAdminRole = (ctx: LeadsAccessContext, id: string): boolean =>
  ctx.allRolesExempt === true || ctx.adminRoleIds?.has(id) === true;

/**
 * The overwrites for a new leads channel: the category's own first (sending
 * any overwrites replaces what a channel would inherit, so a private category
 * stays private), then the restriction described above.
 */
export function buildLeadsOverwrites(
  base: readonly OverwriteSpec[],
  ctx: LeadsAccessContext,
): OverwriteSpec[] {
  const specs = new Map<string, OverwriteSpec>();
  for (const o of base) specs.set(keyOf(o), { ...o });
  const desired = desiredMembers(ctx);

  const everyoneKey = keyOf({ type: OverwriteType.Role, id: ctx.everyoneId });
  const restricted = restrictEveryone(
    specs.get(everyoneKey),
    ctx.everyoneId,
    ctx.categoryUnknown === true,
  );
  specs.set(everyoneKey, restricted);

  for (const [key, spec] of specs) {
    if (spec.type === OverwriteType.Member && !desired.has(spec.id)) {
      spec.allow &= ~LEADS_LEADER_PERMISSIONS;
      if (spec.allow === 0n && spec.deny === 0n) specs.delete(key);
    }
  }
  // The roles, by the one rule; the category is the copy this started from.
  const grants =
    ctx.allRolesExempt === true ? new Set<string>() : ctx.adminGrantRoleIds;
  const baseByKey = new Map(base.map((o) => [keyOf(o), o]));
  const roleIds = new Set<string>(grants ?? []);
  for (const o of specs.values()) {
    if (o.type === OverwriteType.Role && o.id !== ctx.everyoneId) {
      roleIds.add(o.id);
    }
  }
  const categoryHides = (restricted.deny & VIEW) !== 0n;
  for (const id of roleIds) {
    const grant = grants?.has(id) === true;
    if (isAdminRole(ctx, id) && !grant) continue;
    const key = keyOf({ type: OverwriteType.Role, id });
    const spec = desiredRoleEntry(id, specs.get(key), baseByKey.get(key), {
      grant,
      categoryDeniesView: categoryHides,
      viewBlocked: categoryHides,
    });
    if (spec) specs.set(key, spec);
    else specs.delete(key);
  }
  for (const [id, bits] of desired) {
    const key = keyOf({ type: OverwriteType.Member, id });
    specs.set(key, widen(specs.get(key), id, bits));
  }
  return [...specs.values()];
}

export type LeadsOp =
  | { kind: "put"; spec: OverwriteSpec; revoke: boolean }
  | { kind: "delete"; id: string; type: OverwriteType; revoke: true };

/**
 * What to write so the channel's CURRENT overwrites (read fresh from Discord)
 * match the rules, in the order they should be sent: revokes first (a failure
 * half way leaves too little access, never too much), then the restriction of
 * @everyone, then the grants. Empty when the channel is already right.
 */
export function planLeadsSync(
  current: readonly OverwriteSpec[],
  ctx: LeadsAccessContext,
): LeadsOp[] {
  const ops: LeadsOp[] = [];
  const desired = desiredMembers(ctx);
  const byKey = new Map(current.map((o) => [keyOf(o), o]));

  // 1. Members who must not have the access any more.
  for (const o of current) {
    if (o.type !== OverwriteType.Member || desired.has(o.id)) continue;
    if ((o.allow & LEADS_LEADER_PERMISSIONS) === 0n) continue;
    const allow = o.allow & ~LEADS_LEADER_PERMISSIONS;
    if (allow === 0n && o.deny === 0n) {
      ops.push({ kind: "delete", id: o.id, type: o.type, revoke: true });
    } else {
      ops.push({
        kind: "put",
        spec: { id: o.id, type: o.type, allow, deny: o.deny },
        revoke: true,
      });
    }
  }

  // What the category itself denies counts as denied here: the channel's own
  // entries may have lost it, and it is never lifted (nor View granted over it).
  const category = new Map(
    (ctx.categoryOverwrites ?? []).map((o) => [keyOf(o), o]),
  );
  const categoryEveryone = category.get(
    keyOf({ type: OverwriteType.Role, id: ctx.everyoneId }),
  );
  const viewBlocked =
    ctx.categoryUnknown === true ||
    ((categoryEveryone?.deny ?? 0n) & VIEW) !== 0n;
  const categoryDeniesView = ((categoryEveryone?.deny ?? 0n) & VIEW) !== 0n;

  // 2. The roles, by the one rule (see `desiredRoleEntry`): on every pass,
  // for every role in the channel, in the category or granted as an admin
  // group's. Whether an earlier clean-up ran cannot be told from the channel,
  // so it is simply never left undone. A role with the Administrator
  // permission is not touched (it bypasses overwrites), nor is any role while
  // the admin groups are unknown; without a readable category nothing is
  // derived from it.
  const grants =
    ctx.allRolesExempt === true ? new Set<string>() : ctx.adminGrantRoleIds;
  const roleIds = new Set<string>(grants ?? []);
  for (const o of [...current, ...category.values()]) {
    if (o.type === OverwriteType.Role && o.id !== ctx.everyoneId) {
      roleIds.add(o.id);
    }
  }
  const everyoneNow = byKey.get(
    keyOf({ type: OverwriteType.Role, id: ctx.everyoneId }),
  );
  const grantViewBlocked =
    viewBlocked || ((everyoneNow?.deny ?? 0n) & VIEW) !== 0n;
  for (const id of roleIds) {
    const grant = grants?.has(id) === true;
    if (isAdminRole(ctx, id) && !grant) continue;
    const key = keyOf({ type: OverwriteType.Role, id });
    const own = byKey.get(key);
    const wanted = desiredRoleEntry(id, own, category.get(key), {
      grant,
      categoryDeniesView,
      viewBlocked: grantViewBlocked,
    });
    if (!wanted) {
      if (own && (own.allow !== 0n || own.deny !== 0n)) {
        ops.push({
          kind: "delete",
          id,
          type: OverwriteType.Role,
          revoke: true,
        });
      }
      continue;
    }
    if (own && own.allow === wanted.allow && own.deny === wanted.deny) continue;
    ops.push({
      kind: "put",
      spec: wanted,
      revoke: ((own?.allow ?? 0n) & ~wanted.allow) !== 0n,
    });
  }
  // ... and @everyone itself.
  const everyone = byKey.get(
    keyOf({ type: OverwriteType.Role, id: ctx.everyoneId }),
  );
  // (A deny of Connect with no View allowed or denied is repaired too: the
  // channel was made without the rule, as creation would have, unless View is
  // blocked. And a category that denies View to @everyone is enforced: the
  // deny is copied and a contradicting allow removed.)
  if (
    !everyone ||
    (everyone.deny & CONNECT) === 0n ||
    (((everyone.allow | everyone.deny) & VIEW) === 0n && !viewBlocked) ||
    (categoryDeniesView &&
      ((everyone.deny & VIEW) === 0n || (everyone.allow & VIEW) !== 0n))
  ) {
    ops.push({
      kind: "put",
      spec: restrictEveryone(
        everyone,
        ctx.everyoneId,
        viewBlocked,
        categoryDeniesView,
      ),
      revoke: false,
    });
  }

  // 3. The members who must have it.
  for (const [id, bits] of desired) {
    const o = byKey.get(keyOf({ type: OverwriteType.Member, id }));
    if (o && (o.allow & bits) === bits && (o.deny & bits) === 0n) continue;
    ops.push({ kind: "put", spec: widen(o, id, bits), revoke: false });
  }
  return ops;
}

/** The user ids a plan takes access from. */
export function revokedUserIds(ops: readonly LeadsOp[]): string[] {
  const ids: string[] = [];
  for (const op of ops) {
    if (!op.revoke) continue;
    const spec = op.kind === "put" ? op.spec : op;
    if (spec.type === OverwriteType.Member) ids.push(spec.id);
  }
  return ids;
}

/** A stable text of a plan, to recognise the same write wanted twice in a row. */
export function describePlan(ops: readonly LeadsOp[]): string {
  return JSON.stringify(ops, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

// ---------------------------------------------------------------------
// Moving a person out of the channel
// ---------------------------------------------------------------------

export interface EvictionEvent {
  channelId?: string | null;
  createdBy?: string;
  captainsEnabled?: boolean;
  groups?: readonly LeaderGroup[];
}

export interface EvictionPresence {
  ok: boolean;
  members: ReadonlyArray<{ id: string; channelId: string }>;
}

/**
 * Who is moved out of the leads channel, for `moveEventMembers`: the people
 * connected to it now who are not the host, not a current leader and not an
 * administrator, and who either lost access just now (`revoked`) or cannot
 * connect according to the gateway's permission cache. Runs on the FRESH row.
 * Each goes to the channel of the team group they are in, else to the main
 * channel (the issue's rule), and is pinned to the leads channel as the place
 * they move from (`fromChannelId`), so someone who has walked elsewhere in the
 * meantime is left alone.
 */
export function planLeadsEviction(
  event: EvictionEvent,
  presence: EvictionPresence,
  opts: {
    revoked: ReadonlySet<string>;
    isAdmin: (userId: string) => boolean;
    /** The cache's answer, or null when it cannot tell. */
    canConnect: (userId: string) => boolean | null;
  },
): MovePlan {
  const leadsId = resolveLeadsChannel(event);
  if (!leadsId) return [];
  if (!presence.ok) {
    return {
      refuse: "Who is connected could not be read, so nobody was moved.",
    };
  }
  const keep = new Set<string>(leadsLeaderIds(event));
  if (event.createdBy) keep.add(event.createdBy);
  const wishes: MoveWish[] = [];
  for (const person of presence.members) {
    if (person.channelId !== leadsId || keep.has(person.id)) continue;
    if (opts.isAdmin(person.id)) continue;
    if (!opts.revoked.has(person.id) && opts.canConnect(person.id) !== false) {
      continue;
    }
    const team = (event.groups ?? []).find(
      (g) => g.kind === "team" && (g.memberIds ?? []).includes(person.id),
    );
    const toChannelId = team?.channelId || event.channelId;
    if (!toChannelId || toChannelId === leadsId) continue;
    wishes.push({ userId: person.id, toChannelId, fromChannelId: leadsId });
  }
  return wishes;
}
