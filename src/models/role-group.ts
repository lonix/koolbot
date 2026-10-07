import mongoose, { Document, Schema } from "mongoose";

/**
 * Admin-defined role groups (#1020, part of the server-adoption epic #1017).
 *
 * A group is a named, ranked handle on one Discord role. Admins define as many
 * or as few as they like (Admin, Mod, Helper, VIP, Friends, Bots …); there is
 * no fixed tier set, which is why groups live in their own collection instead
 * of config keys. Features never read `roleId` directly — they ask
 * `RoleGroupService` (`getGroupsWith`, `memberHasCapability`, …) so a role can
 * be swapped without touching any consumer.
 *
 * A group holds no member data: membership is whatever Discord says it is.
 */

/** What a group's members may do. Features query these, not role ids. */
export const ROLE_GROUP_CAPABILITIES = ["admin", "staff", "bot"] as const;
export type RoleGroupCapability = (typeof ROLE_GROUP_CAPABILITIES)[number];

/** How a group reacts when its Discord role drifts from the definition (#1021). */
export const ROLE_GROUP_SYNC_POLICIES = ["enforce", "adopt", "flag"] as const;
export type RoleGroupSyncPolicy = (typeof ROLE_GROUP_SYNC_POLICIES)[number];

export interface IRoleGroup extends Document {
  guildId: string;
  /** Unique per guild, compared case-insensitively. */
  name: string;
  /**
   * The backing Discord role. `null` while the group is waiting for the
   * engine to create its role; set once the plan that creates it is applied.
   */
  roleId: string | null;
  /** Higher is "above" lower; powers "this group and above" gating. */
  rank: number;
  /**
   * Desired Discord permission set as a decimal bitfield. `null` means "leave
   * the role's permissions alone": always the case for a linked existing
   * role until the admin explicitly edits them.
   */
  permissions: string | null;
  capabilities: RoleGroupCapability[];
  /** Desired role colour (0xRRGGBB). `null` = leave as is. */
  colour: number | null;
  /**
   * Desired "show members separately" flag. Recorded for the engine; the
   * adoption engine does not apply it yet.
   */
  hoist: boolean;
  /** KoolBot created the backing role itself, so it may delete it again. */
  createdByKoolbot: boolean;
  /**
   * The backing role is integration-managed (Server Booster, subscriptions,
   * bot roles). Such a group can only be used for gating: it is never edited
   * and has no capability.
   */
  gateOnly: boolean;
  /**
   * Name the backing role is expected to carry; `null` = not tracked. Set when
   * the role is linked, created or adopted, so a group may be named differently
   * from its role without showing as drift forever (#1021).
   */
  roleName: string | null;
  /**
   * The backing role was deleted in Discord (#1021). The group keeps its
   * definition but has no role (`roleId` is null) and is never silently
   * recreated: an admin re-links it, or the *enforce* policy recreates it.
   */
  unlinked: boolean;
  /** Id of the role that was deleted, kept for display and relink safety. */
  lostRoleId: string | null;
  /** Set when a recreate was requested; only roles created after it may link. */
  recreateRequestedAt: Date | null;
  /** Per-group policy override; `null` = use `adoption.role_groups.sync_policy`. */
  syncPolicy: RoleGroupSyncPolicy | null;
  /** Fingerprint of the drift last reported, so a log is only sent on change. */
  driftSignature: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const roleGroupSchema = new Schema<IRoleGroup>(
  {
    guildId: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 100 },
    roleId: { type: String, default: null },
    rank: { type: Number, required: true, default: 0 },
    permissions: { type: String, default: null },
    capabilities: {
      type: [{ type: String, enum: ROLE_GROUP_CAPABILITIES }],
      default: [],
    },
    colour: { type: Number, default: null },
    hoist: { type: Boolean, default: false },
    createdByKoolbot: { type: Boolean, default: false },
    gateOnly: { type: Boolean, default: false },
    roleName: { type: String, default: null },
    unlinked: { type: Boolean, default: false },
    lostRoleId: { type: String, default: null },
    recreateRequestedAt: { type: Date, default: null },
    syncPolicy: {
      type: String,
      enum: [...ROLE_GROUP_SYNC_POLICIES, null],
      default: null,
    },
    driftSignature: { type: String, default: null },
  },
  { timestamps: true },
);

// One group per backing role per guild (groups still waiting for a role have
// no id and are excluded), and one group per name.
roleGroupSchema.index(
  { guildId: 1, roleId: 1 },
  {
    unique: true,
    partialFilterExpression: { roleId: { $type: "string" } },
  },
);
roleGroupSchema.index({ guildId: 1, name: 1 }, { unique: true });

export const RoleGroup = mongoose.model<IRoleGroup>(
  "RoleGroup",
  roleGroupSchema,
);
