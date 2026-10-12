import { createKeyedLock } from "../utils/keyed-lock.js";

/**
 * One in-process queue per guild for everything that creates or tears down
 * generated reaction-role groups (#1064): `ReactionRoleGroupService.provisionGroup`
 * and `ReactionRoleService.deleteReactionRoleGroup`. Per guild, not per group,
 * because roles are reused by name across groups.
 *
 * The lock is not re-entrant. Neither locked section may call the other (or
 * take this lock again), or it would wait on itself forever.
 */
export const reactionRoleGuildLock = createKeyedLock();
