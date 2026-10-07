import {
  BOT_CATEGORY,
  BOT_POSTS,
  botGateSet,
  botReadOnlySet,
  BOT_VOICE_CATEGORY,
  BOT_VOICE_LOBBY,
  NOTICES_BOT,
  channelFamily,
  gateEveryone,
  gateMember,
  mergeOverwrite,
  readOnlyEveryone,
  readOnlyPoster,
  bitsOf,
  NOTICES_EVERYONE,
  type ChannelFamily,
  type PermissionName,
  type PermissionSet,
} from "../utils/channel-permissions.js";
import { matchesVoiceNamingPattern } from "../utils/voice-naming.js";
import { defaultConfig } from "./config-schema.js";
import type { GroupSpec } from "./role-group-plan.js";
import type {
  ChannelState,
  ConfigValue,
  DesiredOverwrite,
  DesiredOverwriteRemoval,
  DesiredState,
  DestructiveApproval,
  PlanIssue,
  PlanOperation,
  ScannedState,
} from "./server-adoption-planner.js";

/**
 * Pure translation from "what the admin wants done with these categories and
 * channels" to the `DesiredState` the adoption engine (#1018) plans against
 * (#1022). No Discord or database access.
 *
 * Everything defaults to leaving a channel alone. The actions are additive or
 * reversible edits (every one snapshotted by the engine):
 *
 * - `read-only`: `@everyone` can't post (rules differ for forums, stages and
 *   voice), the bot can, chosen groups optionally can;
 * - `gate`: only chosen roles / groups (or "a group and above") can see it;
 * - `sync`: make the channel's overwrites match its category. The only
 *   action that *replaces* existing permissions: it is never pre-selected and
 *   removing a channel's own overwrites needs a per-channel approval;
 * - `bindKey`: write the feature's channel/category config key and give the
 *   bot the permissions that feature expects.
 *
 * Only `@everyone`, the bot, and the roles the admin chose are ever written.
 * Overwrites for other bots, other roles and members are left as they are, and
 * unrelated bits on a touched overwrite are preserved.
 */

export type ClaimAction = "leave" | "read-only" | "gate" | "sync";

export const CLAIM_ACTIONS: readonly ClaimAction[] = [
  "leave",
  "read-only",
  "gate",
  "sync",
];

export interface ChannelClaim {
  channelId: string;
  action: ClaimAction;
  /** Config key of the feature this channel is bound to, if any. */
  bindKey?: string;
  /** gate: roles allowed in. read-only: roles that may still post. */
  roleIds?: string[];
  /** gate: this group and every group ranked above it are allowed in. */
  minGroupId?: string;
  /** read-only: members can still react (default: reactions are denied). */
  allowReactions?: boolean;
  /** read-only forum: members can't reply inside posts either. */
  lockReplies?: boolean;
  /** sync: the admin approved replacing this channel's own overwrites. */
  approveReplace?: boolean;
  /** Voice category bind: also turn on managed-only cleanup (see #1032). */
  voiceManagedOnly?: boolean;
  /** Voice category bind: adopt the server's naming prefix. */
  usePrefix?: boolean;
}

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

export type FeatureKind = "text" | "category" | "voice";

export interface FeatureTarget {
  key: string;
  label: string;
  kind: FeatureKind;
  /** What the bot needs in the bound channel or category. */
  botPermissions: PermissionSet;
  /** The feature's channel is read-only for everyone but the bot. */
  readOnly?: boolean;
  /** What `@everyone` is given there, for a feature that locks its channel. */
  everyone?: PermissionSet;
  /**
   * The feature's own cleanup job deletes messages in its channel that the bot
   * did not post, once the feature is enabled. Binding such a channel is
   * blocked while the feature is on; otherwise the plan says what will happen.
   */
  purges?: { enabledKey: string; what: string };
}

const textTarget = (
  key: string,
  label: string,
  extra: Partial<FeatureTarget> = {},
): FeatureTarget => ({
  key,
  label,
  kind: "text",
  botPermissions: BOT_POSTS,
  ...extra,
});

/**
 * Every config key a channel or category can be bound to. Keys outside this
 * list are refused, so a tampered form can't write arbitrary settings.
 */
export const FEATURE_TARGETS: readonly FeatureTarget[] = [
  textTarget("quotes.channel_id", "Quotes", {
    purges: {
      enabledKey: "quotes.enabled",
      what: "every few minutes the quote channel cleanup deletes the latest messages KoolBot didn't post, and quote sync (quotes.clear_on_sync) clears the whole channel",
    },
  }),
  textTarget("notices.channel_id", "Notices", {
    botPermissions: NOTICES_BOT,
    readOnly: true,
    everyone: NOTICES_EVERYONE,
    purges: {
      enabledKey: "notices.enabled",
      what: "every few minutes the notices channel cleanup deletes the latest messages KoolBot didn't post",
    },
  }),
  textTarget("reactionroles.message_channel_id", "Reaction role picker"),
  textTarget("voicetracking.announcements.channel_id", "Voice stats"),
  textTarget("birthdays.channel_id", "Birthdays"),
  textTarget("celebrations.channel_id", "Celebrations"),
  textTarget("welcome.channel_id", "Welcome messages"),
  textTarget("lfg.channel_id", "Looking for group"),
  textTarget("events.announcement_channel_id", "Event announcements"),
  textTarget(
    "leaderboard_roles.announcement_channel_id",
    "Leaderboard role announcements",
  ),
  textTarget("core.startup.channel_id", "Log: startup"),
  textTarget("core.errors.channel_id", "Log: errors"),
  textTarget("core.cleanup.channel_id", "Log: cleanup"),
  textTarget("core.config.channel_id", "Log: config changes"),
  textTarget("core.cron.channel_id", "Log: scheduled jobs"),
  textTarget("core.moderation.channel_id", "Log: moderation"),
  textTarget("core.moderation_review.channel_id", "Log: moderation review"),
  textTarget("core.updates.channel_id", "Log: updates"),
  {
    key: "voicechannels.category_id",
    label: "Voice channels category",
    kind: "category",
    botPermissions: BOT_VOICE_CATEGORY,
  },
  {
    key: "voicechannels.lobby.channel_id",
    label: "Voice lobby",
    kind: "voice",
    botPermissions: BOT_VOICE_LOBBY,
  },
  {
    key: "events.category_id",
    label: "Event voice channels category",
    kind: "category",
    botPermissions: BOT_CATEGORY,
  },
  {
    key: "tickets.category_id",
    label: "Tickets category",
    kind: "category",
    botPermissions: BOT_CATEGORY,
  },
];

export function featureTarget(key: string): FeatureTarget | undefined {
  return FEATURE_TARGETS.find((f) => f.key === key);
}

const VOICE_MANAGED_ONLY = "voicechannels.cleanup.managed_only";
const VOICE_CATEGORY = "voicechannels.category_id";
const VOICE_LOBBY = "voicechannels.lobby.channel_id";
const VOICE_PREFIX = "voicechannels.channel.prefix";
const VOICE_SUFFIX = "voicechannels.channel.suffix";

// ---------------------------------------------------------------------------
// Context and result
// ---------------------------------------------------------------------------

export interface ClaimContext {
  scanned: ScannedState;
  groups: readonly GroupSpec[];
  /** Managed roles that belong to a bot integration: never a gate target. */
  integrationRoleIds: ReadonlySet<string>;
  /** `syncedToParent` per channel, from the scan. */
  syncedToParent: ReadonlyMap<string, boolean | null>;
  /** Without the members intent other bots' member overwrites are unknown. */
  membersIntent: boolean;
  /** The detected channel naming prefix, e.g. `🔊 | `. */
  suggestedPrefix: string | null;
  /** The first managed-only cleanup already ran for this server. */
  voiceMigrationDone?: boolean;
  /** Stamp for approvals; fixed by the caller so plan ids are reproducible. */
  approvedAt: string;
}

export interface ClaimsDesired {
  desired: DesiredState;
  issues: PlanIssue[];
  /** Managed (non-bot) roles named as gate targets: see `PlanOptions`. */
  gateTargetIds: string[];
}

interface Running {
  type: "role" | "member";
  allow: string;
  deny: string;
  touched: boolean;
}

const isTrue = (v: ConfigValue | undefined): boolean =>
  v === true || v === "true";

/** Build the desired state for a set of claims. */
export function buildClaimsDesiredState(
  claims: readonly ChannelClaim[],
  ctx: ClaimContext,
): ClaimsDesired {
  const { scanned } = ctx;
  const issues: PlanIssue[] = [];
  const err = (code: string, message: string, targetId?: string): void => {
    issues.push({ code, message, targetId });
  };
  const everyoneId = scanned.guildId;
  const channels = new Map(scanned.channels.map((c) => [c.id, c]));
  const roles = new Map(scanned.roles.map((r) => [r.id, r]));
  const otherBots = new Set(scanned.otherBotIds);
  const gateTargetIds = new Set<string>();

  // ---- running overwrite state per (channel, target) ----------------------
  const running = new Map<string, Running>();
  const touchedOrder: string[] = [];
  const key = (channelId: string, targetId: string): string =>
    `${channelId}:${targetId}`;
  const layer = (
    channel: ChannelState,
    targetId: string,
    type: "role" | "member",
    set: PermissionSet,
  ): void => {
    const k = key(channel.id, targetId);
    let cur = running.get(k);
    if (!cur) {
      const existing = channel.overwrites.find((o) => o.id === targetId);
      cur = {
        type: existing?.type ?? type,
        allow: existing?.allow ?? "0",
        deny: existing?.deny ?? "0",
        touched: false,
      };
      running.set(k, cur);
      touchedOrder.push(k);
    }
    const merged = mergeOverwrite({ allow: cur.allow, deny: cur.deny }, set);
    cur.allow = merged.allow;
    cur.deny = merged.deny;
    cur.touched = true;
  };

  // ---- validate and de-duplicate claims -----------------------------------
  const seen = new Set<string>();
  const valid: Array<{ claim: ChannelClaim; channel: ChannelState }> = [];
  for (const claim of claims) {
    const channel = channels.get(claim.channelId);
    if (!channel) {
      err(
        "unknown-channel",
        `Channel ${claim.channelId} was not found.`,
        claim.channelId,
      );
      continue;
    }
    if (seen.has(claim.channelId)) {
      err(
        "duplicate-claim",
        `"${channel.name}" has more than one claim.`,
        claim.channelId,
      );
      continue;
    }
    seen.add(claim.channelId);
    if (!CLAIM_ACTIONS.includes(claim.action)) {
      err(
        "unknown-action",
        `"${channel.name}" has an unknown action.`,
        claim.channelId,
      );
      continue;
    }
    valid.push({ claim, channel });
  }
  const claimed = new Set(valid.map((v) => v.channel.id));

  // ---- role targets -------------------------------------------------------
  const resolveTargets = (
    claim: ChannelClaim,
    channel: ChannelState,
  ): string[] | null => {
    const ids = new Set<string>(claim.roleIds ?? []);
    if (claim.minGroupId) {
      const base = ctx.groups.find((g) => g.id === claim.minGroupId);
      if (!base) {
        err(
          "unknown-group",
          `The group chosen for "${channel.name}" no longer exists.`,
          channel.id,
        );
        return null;
      }
      for (const g of ctx.groups) {
        if (g.rank >= base.rank && g.roleId) ids.add(g.roleId);
      }
    }
    let ok = true;
    for (const id of ids) {
      const role = roles.get(id);
      if (!role) {
        err("unknown-role", `Role ${id} does not exist.`, channel.id);
        ok = false;
      } else if (id === everyoneId) {
        err(
          "role-protected",
          "@everyone can't be chosen as a group target.",
          channel.id,
        );
        ok = false;
      } else if (ctx.integrationRoleIds.has(id)) {
        err(
          "other-bot-overwrite",
          `"${role.name}" belongs to a bot integration and can't be used to gate "${channel.name}".`,
          channel.id,
        );
        ok = false;
      } else if (role.managed) {
        // Server Booster / subscription role: usable as a target, never edited.
        gateTargetIds.add(id);
      }
    }
    return ok ? [...ids] : null;
  };

  const botSetFor = (
    family: ChannelFamily,
    feature: FeatureTarget | undefined,
    readOnlyClaim: boolean,
  ): PermissionSet => {
    if (feature) return feature.botPermissions;
    return readOnlyClaim ? botReadOnlySet(family) : botGateSet(family);
  };

  const removals: DesiredOverwriteRemoval[] = [];
  const approvals: DestructiveApproval[] = [];
  const config: Record<string, ConfigValue> = {};
  const featureChannels: Array<{
    channelId: string;
    feature: string;
    permissions?: string;
  }> = [];
  const boundKeys = new Map<string, string>();

  /**
   * Overwrites KoolBot deliberately keeps (other roles, members) can allow what
   * `@everyone` is now denied and so bypass the claim. Say so, naming them,
   * rather than presenting the channel as exclusive.
   */
  const warned = new Set<string>();
  const bypassCheck = (
    channel: ChannelState,
    names: readonly PermissionName[],
    chosen: readonly string[],
    code: string,
    what: string,
  ): void => {
    const bits = BigInt(bitsOf(names));
    const offenders: string[] = [];
    for (const o of channel.overwrites) {
      if (
        o.id === everyoneId ||
        o.id === scanned.botUserId ||
        scanned.botRoleIds.includes(o.id) ||
        otherBots.has(o.id) ||
        ctx.integrationRoleIds.has(o.id) ||
        chosen.includes(o.id)
      )
        continue;
      const now = running.get(key(channel.id, o.id));
      if ((BigInt(now?.allow ?? o.allow) & bits) === 0n) continue;
      offenders.push(
        o.type === "role"
          ? `@${roles.get(o.id)?.name ?? o.id}`
          : `member ${o.id}`,
      );
    }
    const mark = `${code}:${channel.id}`;
    if (offenders.length === 0 || warned.has(mark)) return;
    warned.add(mark);
    issues.push({
      code,
      message: `"${channel.name}" is only partly ${what}: ${offenders.join(", ")} already ${code === "gate-not-exclusive" ? "can see it" : "can post"} through their own overwrites, which are kept. Change those in Discord, or choose "Sync to category", if you want it exclusive.`,
      targetId: channel.id,
    });
  };

  // Applies a gate or read-only treatment to one channel.
  const gate = (
    channel: ChannelState,
    family: ChannelFamily,
    targets: string[],
    bot: PermissionSet,
  ): void => {
    layer(channel, everyoneId, "role", gateEveryone(family));
    for (const id of targets) layer(channel, id, "role", gateMember(family));
    layer(channel, scanned.botUserId, "member", bot);
    bypassCheck(
      channel,
      family === "voice" || family === "stage" || family === "mixed"
        ? ["ViewChannel", "Connect"]
        : ["ViewChannel"],
      targets,
      "gate-not-exclusive",
      "gated",
    );
  };
  const readOnly = (
    channel: ChannelState,
    family: ChannelFamily,
    claim: ChannelClaim,
    posters: string[],
    bot: PermissionSet,
  ): void => {
    layer(
      channel,
      everyoneId,
      "role",
      readOnlyEveryone(family, {
        allowReactions: claim.allowReactions ?? false,
        lockReplies: claim.lockReplies ?? false,
      }),
    );
    for (const id of posters) {
      layer(channel, id, "role", readOnlyPoster(family));
    }
    // A group role that an earlier admin allowed to post would still post
    // through its own overwrite: close that, but only where such an allow
    // exists. Other roles' overwrites are otherwise left alone.
    const denyPost: PermissionSet = {
      allow: [],
      deny: readOnlyEveryone(family, {
        allowReactions: true,
        lockReplies: claim.lockReplies ?? false,
      }).deny,
    };
    const postBits = BigInt(bitsOf(denyPost.deny));
    for (const g of ctx.groups) {
      if (!g.roleId || posters.includes(g.roleId)) continue;
      const existing = channel.overwrites.find((o) => o.id === g.roleId);
      if (existing && (BigInt(existing.allow) & postBits) !== 0n) {
        layer(channel, g.roleId, "role", denyPost);
      }
    }
    layer(channel, scanned.botUserId, "member", bot);
    bypassCheck(
      channel,
      denyPost.deny,
      posters,
      "read-only-not-exclusive",
      "read-only",
    );
  };

  const bindFeature = (
    claim: ChannelClaim,
    channel: ChannelState,
    family: ChannelFamily,
  ): FeatureTarget | undefined => {
    if (!claim.bindKey) return undefined;
    const feature = featureTarget(claim.bindKey);
    if (!feature) {
      err(
        "unknown-config-key",
        `"${claim.bindKey}" is not a channel setting KoolBot can bind.`,
        channel.id,
      );
      return undefined;
    }
    const kindOk =
      feature.kind === "category"
        ? channel.kind === "category"
        : feature.kind === "voice"
          ? family === "voice"
          : channel.kind === "text" && family !== "forum" && family !== "stage";
    if (!kindOk) {
      err(
        "feature-channel-mismatch",
        `"${channel.name}" is a ${family} channel; ${feature.label} needs a ${feature.kind === "text" ? "text" : feature.kind} channel.`,
        channel.id,
      );
      return undefined;
    }
    const earlier = boundKeys.get(feature.key);
    if (earlier && earlier !== channel.id) {
      err(
        "duplicate-binding",
        `${feature.label} is bound to more than one channel in this plan.`,
        channel.id,
      );
      return undefined;
    }
    boundKeys.set(feature.key, channel.id);
    if (feature.purges && scanned.config[feature.key] !== channel.id) {
      const enabled = isTrue(scanned.config[feature.purges.enabledKey]);
      if (enabled) {
        err(
          "feature-deletes-messages",
          `${feature.label} is enabled, and ${feature.purges.what}. Binding "${channel.name}" would delete its existing messages outside this plan, and a rollback can't restore them. Use a channel with nothing to keep, or turn ${feature.label} off first and review before enabling it.`,
          channel.id,
        );
      } else {
        issues.push({
          code: "feature-deletes-messages-later",
          message: `Once ${feature.label} is enabled, ${feature.purges.what}. Messages in "${channel.name}" you want to keep should be moved first; nothing is deleted by this plan.`,
          targetId: channel.id,
        });
      }
    }
    return feature;
  };

  /** The prefix KoolBot will name voice channels with once the plan is applied. */
  const voicePrefixAfter = (claim: ChannelClaim): string => {
    if (claim.usePrefix && ctx.suggestedPrefix) {
      return ctx.suggestedPrefix.trim();
    }
    return String(
      scanned.config[VOICE_PREFIX] ??
        defaultConfig["voicechannels.channel.prefix"],
    );
  };

  const voiceBindChecks = (
    claim: ChannelClaim,
    channel: ChannelState,
  ): void => {
    const alreadyBound = scanned.config[VOICE_CATEGORY] === channel.id;
    const managedOnly = isTrue(scanned.config[VOICE_MANAGED_ONLY]);
    const lobbyId =
      valid.find((v) => v.claim.bindKey === VOICE_LOBBY)?.channel.id ??
      String(scanned.config[VOICE_LOBBY] ?? "");
    // The lobby is matched by name too, so cleanup keeps it either way.
    const lobbyNames = new Set([
      String(scanned.config["voicechannels.lobby.name"] ?? "Lobby"),
      String(
        scanned.config["voicechannels.lobby.offlinename"] ?? "Offline Lobby",
      ),
    ]);
    const voiceChildren = scanned.channels.filter(
      (c) =>
        c.parentId === channel.id &&
        c.kind === "voice" &&
        c.id !== lobbyId &&
        !lobbyNames.has(c.name),
    );
    const names = (list: ChannelState[]): string =>
      list.map((c) => `"${c.name}"`).join(", ");

    if (!alreadyBound && !managedOnly && !claim.voiceManagedOnly) {
      // Legacy cleanup deletes every empty voice channel in this category.
      // Occupied channels count too: the periodic sweep deletes an unmanaged
      // channel as soon as it empties.
      const atRisk = voiceChildren;
      if (atRisk.length > 0) {
        err(
          "voice-cleanup-risk",
          `Binding "${channel.name}" as the voice category would let KoolBot's cleanup delete these voice channels once they are empty: ${names(atRisk)}. Use a dedicated category, or also turn on managed-only cleanup so only channels KoolBot created are removed.`,
          channel.id,
        );
      }
    }
    if (claim.voiceManagedOnly && !managedOnly) {
      // Listed before the category key so cleanup is already restricted when
      // the category is bound.
      config[VOICE_MANAGED_ONLY] = true;
    }
    if (managedOnly || claim.voiceManagedOnly) {
      // The first managed-only cleanup records every voice channel here that
      // follows the naming pattern as KoolBot's own, and later deletes it once
      // empty (#1032). A pattern another bot's channels also follow is unsafe.
      if (!ctx.voiceMigrationDone) {
        const prefix = voicePrefixAfter(claim);
        const suffix = String(scanned.config[VOICE_SUFFIX] ?? "");
        const lookalikes = voiceChildren.filter((c) =>
          matchesVoiceNamingPattern(c.name, prefix, suffix),
        );
        if (lookalikes.length > 0) {
          err(
            "voice-adoption-risk",
            `With the voice naming ${prefix ? `prefix "${prefix}"` : "suffix"}, KoolBot's first managed-only cleanup would treat these channels in "${channel.name}" as its own and delete them once empty: ${names(lookalikes)}. Use a dedicated category, or keep a prefix or suffix those channels don't follow.`,
            channel.id,
          );
        }
      }
      issues.push({
        code: "voice-managed-only",
        message: `With managed-only cleanup, only channels KoolBot created (or recognised by its naming pattern on the first cleanup run) are ever deleted from "${channel.name}".`,
        targetId: channel.id,
      });
    }
    if (scanned.otherBotIds.length > 0) {
      issues.push({
        code: "voice-handover",
        message: `Another bot may run join-to-create here. Disable it before enabling voicechannels.enabled: two bots on one lobby would each create a channel for every joiner.`,
        targetId: channel.id,
      });
    }
  };

  // ---- per-claim handling -------------------------------------------------
  for (const { claim, channel } of valid) {
    const family = channelFamily(channel.rawType, channel.kind);
    const feature = bindFeature(claim, channel, family);
    if (feature) {
      if (feature.key === VOICE_CATEGORY) voiceBindChecks(claim, channel);
      config[feature.key] = channel.id;
      const current = scanned.config[feature.key];
      if (current && String(current) !== "" && current !== channel.id) {
        issues.push({
          code: "rebind",
          message: `${feature.label} is currently bound to another channel (${String(current)}); this changes it.`,
          targetId: channel.id,
        });
      }
      featureChannels.push({
        channelId: channel.id,
        feature: feature.label,
        permissions: bitsOf(feature.botPermissions.allow),
      });
      if (feature.key === VOICE_CATEGORY && claim.usePrefix) {
        if (ctx.suggestedPrefix)
          config[VOICE_PREFIX] = ctx.suggestedPrefix.trim();
        else
          issues.push({
            code: "no-naming-prefix",
            message: "No naming prefix was detected on this server.",
            targetId: channel.id,
          });
      }
    }

    switch (claim.action) {
      case "leave":
        break;
      case "gate": {
        const targets = resolveTargets(claim, channel);
        if (!targets) break;
        if (targets.length === 0) {
          err(
            "gate-needs-target",
            `Choose at least one role or group that may see "${channel.name}".`,
            channel.id,
          );
          break;
        }
        // A category carries the union of the voice and text rules, so a
        // synced voice or stage child gets Connect denied too.
        const gateFamily = family === "category" ? "mixed" : family;
        const gateBot = botSetFor(gateFamily, feature, false);
        gate(channel, gateFamily, targets, gateBot);
        // Discord does not push a category's overwrites to its channels, so
        // the ones synced to it get the identical set. Mirroring it exactly
        // (rather than a per-type variant) keeps them reading as synced.
        if (family === "category") {
          for (const child of scanned.channels) {
            if (child.parentId !== channel.id || claimed.has(child.id))
              continue;
            if (ctx.syncedToParent.get(child.id) !== true) continue;
            gate(child, "mixed", targets, gateBot);
          }
        }
        break;
      }
      case "read-only": {
        const posters = resolveTargets(claim, channel);
        if (!posters) break;
        // A category carries the union of text, voice and stage rules so the
        // channels synced to it mirror it exactly and keep reading as synced.
        const roFamily = family === "category" ? "mixed" : family;
        const roBot = botSetFor(roFamily, feature, true);
        readOnly(channel, roFamily, claim, posters, roBot);
        if (family === "category") {
          for (const child of scanned.channels) {
            if (child.parentId !== channel.id || claimed.has(child.id))
              continue;
            if (ctx.syncedToParent.get(child.id) !== true) continue;
            readOnly(child, "mixed", claim, posters, roBot);
          }
        }
        break;
      }
      case "sync": {
        const parent = channel.parentId
          ? channels.get(channel.parentId)
          : undefined;
        if (!parent) {
          err(
            "no-parent",
            `"${channel.name}" has no category to sync with.`,
            channel.id,
          );
          break;
        }
        const parentKeys = new Set(parent.overwrites.map((o) => o.id));
        let unmatchedProtected = 0;
        for (const o of parent.overwrites) {
          // Another bot's overwrite is never copied or replaced; if the
          // channel doesn't already match it, it can't read as fully synced.
          if (otherBots.has(o.id) || ctx.integrationRoleIds.has(o.id)) {
            const mine = channel.overwrites.find((x) => x.id === o.id);
            if (
              !mine ||
              BigInt(mine.allow) !== BigInt(o.allow) ||
              BigInt(mine.deny) !== BigInt(o.deny)
            ) {
              unmatchedProtected += 1;
            }
            continue;
          }
          // Server Booster and similar roles are valid overwrite targets.
          const parentRole = roles.get(o.id);
          if (parentRole?.managed && !scanned.botRoleIds.includes(o.id)) {
            gateTargetIds.add(o.id);
          }
          running.set(key(channel.id, o.id), {
            type: o.type,
            allow: o.allow,
            deny: o.deny,
            touched: true,
          });
          touchedOrder.push(key(channel.id, o.id));
        }
        const own = channel.overwrites.filter(
          (o) => !parentKeys.has(o.id) && o.id !== scanned.botUserId,
        );
        const removable = own.filter((o) => {
          if (otherBots.has(o.id)) return false;
          const role = roles.get(o.id);
          if (role?.managed && !scanned.botRoleIds.includes(o.id)) return false;
          // Without the members intent a member overwrite might be a bot's.
          if (o.type === "member" && !ctx.membersIntent) return false;
          return true;
        });
        const preserved = own.length - removable.length + unmatchedProtected;
        if (preserved > 0) {
          issues.push({
            code: "sync-partial",
            message: `${preserved} overwrite(s) on "${channel.name}" belong to other bots, differ from the category's, or can't be told apart from them, so they are kept and the channel won't read as fully synced.`,
            targetId: channel.id,
          });
        }
        if (removable.length > 0) {
          if (!claim.approveReplace) {
            err(
              "approval-required",
              `Syncing "${channel.name}" replaces ${removable.length} permission overwrite(s) it has of its own. Tick the approval for this channel to include it; the previous overwrites are saved in the snapshot.`,
              channel.id,
            );
          } else {
            for (const o of removable) {
              removals.push({ channelId: channel.id, targetId: o.id });
              approvals.push({
                kind: "overwrite.remove",
                targetId: key(channel.id, o.id),
                approvedBy: scanned.adminUserId,
                approvedAt: ctx.approvedAt,
              });
            }
          }
        }
        break;
      }
    }

    // A bound feature always keeps the bot's access, whatever the action.
    if (feature) {
      layer(channel, scanned.botUserId, "member", feature.botPermissions);
      if (feature.everyone && claim.action === "leave") {
        // e.g. the notices channel: read-only for everyone but the bot.
        layer(channel, everyoneId, "role", feature.everyone);
      }
    }
  }

  // ---- emit one overwrite per touched (channel, target) --------------------
  const overwrites: DesiredOverwrite[] = [];
  for (const k of touchedOrder) {
    const cur = running.get(k);
    if (!cur || !cur.touched) continue;
    const [channelId, targetId] = k.split(":") as [string, string];
    overwrites.push({
      channelId,
      target: { id: targetId },
      targetType: cur.type,
      allow: cur.allow,
      deny: cur.deny,
    });
  }
  // The same overwrite can be recorded twice for one key (sync + feature).
  const unique = new Map<string, DesiredOverwrite>();
  for (const o of overwrites) unique.set(key(o.channelId, targetKey(o)), o);

  return {
    desired: {
      overwrites: [...unique.values()],
      ...(removals.length ? { overwriteRemovals: removals } : {}),
      ...(approvals.length ? { approvals } : {}),
      config,
      featureChannels: featureChannels.map((f) => ({
        channelId: f.channelId,
        feature: f.feature,
        permissions: f.permissions,
      })),
    },
    issues,
    gateTargetIds: [...gateTargetIds],
  };
}

function targetKey(o: DesiredOverwrite): string {
  return "id" in o.target ? o.target.id : o.target.roleName;
}

/** Codes that stop an apply; the rest are advice shown next to the plan. */
const WARNING_CODES = new Set([
  "rebind",
  "sync-partial",
  "gate-not-exclusive",
  "read-only-not-exclusive",
  "feature-deletes-messages-later",
  "voice-managed-only",
  "voice-handover",
  "no-naming-prefix",
]);

export function isBlocking(issue: PlanIssue): boolean {
  return !WARNING_CODES.has(issue.code);
}

/** Split builder issues into blocking errors and advisory warnings. */
export function splitIssues(issues: readonly PlanIssue[]): {
  errors: PlanIssue[];
  warnings: PlanIssue[];
} {
  return {
    errors: issues.filter(isBlocking),
    warnings: issues.filter((i) => !isBlocking(i)),
  };
}

/**
 * Identity of a step including the state it was approved against: a removal is
 * only "the same" if the overwrite still has the allow/deny bits that were
 * previewed, so a permission someone changed in the meantime is not deleted.
 */
const opKey = (op: PlanOperation): string =>
  op.type === "overwrite.remove"
    ? `${op.type}:${op.channelId}:${op.overwriteTargetId}:${String(op.before?.allow)}:${String(op.before?.deny)}`
    : `${op.type}:${op.id}`;

/**
 * Pending destructive steps that a fresh plan no longer contains in the same
 * form. The engine's live-state check refuses to run while this is non-empty.
 */
export function staleDestructiveSteps(
  pending: readonly PlanOperation[],
  fresh: readonly PlanOperation[],
): string[] {
  const live = new Set(fresh.map(opKey));
  return pending
    .filter((op) => op.class === "destructive" && !live.has(opKey(op)))
    .map((op) => `"${op.summary}" no longer matches the live server`);
}
