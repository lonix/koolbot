import {
  ChannelType,
  GatewayIntentBits,
  PermissionsBitField,
  WebhookType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type OverwriteType,
  type Role,
} from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { ConfigService } from "./config-service.js";
import { getEnvConfigValue } from "../config/env.js";
import { defaultConfig } from "./config-schema.js";
import {
  permissionNames,
  type ChannelKind,
  type ChannelState,
  type ConfigValue,
  type OverwriteState,
  type RoleState,
  type ScannedState,
} from "./server-adoption-planner.js";

/**
 * Read-only guild scanner (#1019). `ServerScanService.scan()` inventories a
 * guild's roles, categories, channels, overwrites, other bots and the bot's
 * own readiness, and returns a typed `ServerScan`. Its `scanned` member is the
 * `ScannedState` the adoption planner (#1018) diffs against; the rest is the
 * richer detail the admin page and the claims step (#1022) render.
 *
 * It performs NO Discord writes. It never pages through the member list: role
 * member counts come from the member cache (flagged approximate), and the
 * admin's own roles are read with a single-member fetch. Message-author
 * sampling (channel ownership hints) is opt-in because it costs one REST call
 * per channel.
 */

export type ScanSeverity = "error" | "warning" | "info";

export interface ReadinessIssue {
  code: string;
  severity: ScanSeverity;
  message: string;
  /** Anchor in TROUBLESHOOTING.md with the fix. */
  help: string;
}

export interface PermissionCheck {
  name: string;
  granted: boolean;
  /** Why KoolBot wants it. */
  purpose: string;
  /** A missing required permission is an error, an optional one a warning. */
  required: boolean;
}

export interface BotReadiness {
  botUserId: string;
  botRoleIds: string[];
  highestRoleId: string | null;
  highestRoleName: string | null;
  highestRolePosition: number;
  /** Total roles in the guild, to make the position readable. */
  roleCount: number;
  administrator: boolean;
  permissions: PermissionCheck[];
  /** Non-managed roles ranked above the bot's highest role. */
  rolesAboveBot: Array<{ id: string; name: string; position: number }>;
  membersIntent: boolean;
  issues: ReadinessIssue[];
  /** True when nothing blocks the adoption engine. */
  ready: boolean;
}

export interface ScanRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
  isEveryone: boolean;
  permissions: string[];
  /** Cached member count; see `memberCountApproximate`. */
  memberCount: number;
  memberCountApproximate: boolean;
  /** Bot id when this is an integration/bot role. */
  botId: string | null;
  botCanManage: boolean;
  /** KoolBot features that already use this role. */
  usedBy: string[];
  /** Assigned by a Discord Onboarding prompt. */
  onboardingManaged: boolean;
}

export interface ScanOverwrite {
  id: string;
  type: "role" | "member";
  /** Role or member name, falling back to the id. */
  label: string;
  allow: string[];
  deny: string[];
}

export interface ChannelFlags {
  afk: boolean;
  rules: boolean;
  system: boolean;
  publicUpdates: boolean;
  /** Fed by a webhook (e.g. a bridge or integration). */
  webhookFed: boolean;
  /** Fed by a followed announcement channel. */
  followed: boolean;
  /** Announcement channel: KoolBot announcements may crosspost. */
  announcement: boolean;
  forum: boolean;
  stage: boolean;
  /** Listed in Onboarding's default channels. */
  onboardingDefault: boolean;
}

export interface ScanChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Discord channel type name, e.g. GuildForum. */
  typeName: string;
  parentId: string | null;
  parentName: string | null;
  /** Null when there is no parent to be synced with. */
  syncedToParent: boolean | null;
  position: number;
  overwrites: ScanOverwrite[];
  /** KoolBot features already bound to this channel (by config). */
  usedBy: string[];
  /** Name-based guess at the KoolBot feature this channel suits. */
  featureGuess: string | null;
  /** `@everyone` denied plus one or more roles allowed on a category/channel. */
  gatedByRoleIds: string[];
  /** A bot that posts most of the sampled messages (opt-in sampling). */
  ownerHint: { botId: string; botTag: string; share: number } | null;
  flags: ChannelFlags;
}

export interface ScanBot {
  userId: string;
  tag: string | null;
  /** Integration role ids belonging to the bot. */
  roleIds: string[];
  /** Channels where the bot (or its role) has an overwrite. */
  overwriteChannelIds: string[];
  /** Webhook-fed channels attributed to it, when known. */
  isKoolBot: boolean;
}

export interface CommunityInfo {
  /** `COMMUNITY` feature on. */
  community: boolean;
  features: string[];
  rulesChannelId: string | null;
  systemChannelId: string | null;
  publicUpdatesChannelId: string | null;
  onboardingEnabled: boolean | null;
  /** Roles and channels Onboarding prompts hand out. */
  onboardingRoleIds: string[];
  onboardingChannelIds: string[];
  onboardingPrompts: Array<{ title: string; roleIds: string[] }>;
}

export interface NamingConvention {
  /** Dominant pattern, or null when the channels do not agree. */
  pattern: "emoji-separator" | "lower-kebab" | "mixed" | null;
  /** Separator between decoration and name, e.g. "|" or "・". */
  separator: string | null;
  /** Share of channels matching the dominant pattern, 0..1. */
  confidence: number;
  samples: string[];
  categoryEmojiPrefix: boolean;
  /** Values that fit `voicechannels.channel.prefix` / `suffix`, if any. */
  suggestedPrefix: string | null;
  suggestedSuffix: string | null;
}

export interface ScheduledEventInfo {
  id: string;
  name: string;
  startsAt: string | null;
  status: string;
  channelId: string | null;
}

export interface ScanSuggestion {
  code: string;
  message: string;
}

export interface ServerScan {
  guildId: string;
  guildName: string;
  scannedAt: string;
  /** The planner's input (#1018). */
  scanned: ScannedState;
  roles: ScanRole[];
  channels: ScanChannel[];
  bots: ScanBot[];
  readiness: BotReadiness;
  community: CommunityInfo;
  naming: NamingConvention;
  scheduledEvents: ScheduledEventInfo[];
  suggestions: ScanSuggestion[];
  /** Parts of the scan that could not be read, and why. */
  partial: string[];
}

export interface ScanOptions {
  /** The admin running the adoption; their roles feed `ScannedState`. */
  adminUserId?: string;
  /** Sample recent message authors for channel ownership hints. */
  sampleMessages?: boolean;
  /** Cap on channels sampled when `sampleMessages` is on. Default 40. */
  sampleChannelLimit?: number;
}

const TROUBLESHOOTING = "TROUBLESHOOTING.md#bot-cant-manage-roles-or-channels";

const { Administrator } = PermissionsBitField.Flags;

/** What KoolBot needs from its guild-level permissions. */
const READINESS_PERMISSIONS: Array<{
  flag: bigint;
  name: string;
  purpose: string;
  required: boolean;
}> = [
  {
    flag: PermissionsBitField.Flags.ViewChannel,
    name: "ViewChannel",
    purpose: "See the channels it posts in and manages",
    required: true,
  },
  {
    flag: PermissionsBitField.Flags.SendMessages,
    name: "SendMessages",
    purpose: "Post announcements, notices and logs",
    required: true,
  },
  {
    flag: PermissionsBitField.Flags.ManageRoles,
    name: "ManageRoles",
    purpose: "Create and assign roles (reaction roles, leaderboard roles)",
    required: true,
  },
  {
    flag: PermissionsBitField.Flags.ManageChannels,
    name: "ManageChannels",
    purpose: "Create voice channels and edit channel permissions",
    required: true,
  },
  {
    flag: PermissionsBitField.Flags.EmbedLinks,
    name: "EmbedLinks",
    purpose: "Render rich embeds",
    required: false,
  },
  {
    flag: PermissionsBitField.Flags.ReadMessageHistory,
    name: "ReadMessageHistory",
    purpose: "Read reaction-role and poll messages",
    required: false,
  },
  {
    flag: PermissionsBitField.Flags.ManageMessages,
    name: "ManageMessages",
    purpose: "Pin and clean up its own messages",
    required: false,
  },
  {
    flag: PermissionsBitField.Flags.MoveMembers,
    name: "MoveMembers",
    purpose: "Move members into temporary voice channels",
    required: false,
  },
];

/** Config keys whose value names channels or roles a feature uses. */
const BINDING_KEY = /(channel_id|category_id|role_id|_channels|_roles)$/;
const SNOWFLAKE = /^\d{15,25}$/;

/** Name fragments → the KoolBot feature the channel would serve. */
const FEATURE_NAME_HINTS: Array<{ test: RegExp; feature: string }> = [
  { test: /quote/i, feature: "quotes" },
  { test: /announce|news/i, feature: "announcements" },
  { test: /voice-?stats|vc-?stats|leaderboard/i, feature: "voicetracking" },
  { test: /birthday/i, feature: "birthdays" },
  { test: /ticket|support/i, feature: "tickets" },
  { test: /poll/i, feature: "polls" },
  { test: /lfg|looking-?for/i, feature: "lfg" },
  { test: /mod-?log|audit|join-?log|server-?log/i, feature: "moderation" },
  { test: /notice|rules/i, feature: "notices" },
  // Grouped so the end anchor visibly applies to "roles" only.
  { test: /(?:self-?roles?|roles$)/i, feature: "reactionroles" },
  { test: /lobby/i, feature: "voicechannels" },
];

const EMOJI_SEP =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})️?\s*([|｜・\-–—:•»])\s*\S/u;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function colorOf(role: Role): number {
  return role.color ?? 0;
}

/** Split a config value into snowflakes (comma/space separated). */
function snowflakes(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => SNOWFLAKE.test(v));
}

function posOf(c: GuildBasedChannel): number {
  return "rawPosition" in c ? (c.rawPosition ?? 0) : 0;
}

function kindOf(type: ChannelType): ChannelKind {
  switch (type) {
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
      return "text";
    case ChannelType.GuildVoice:
    case ChannelType.GuildStageVoice:
      return "voice";
    default:
      return "other";
  }
}

/**
 * Which KoolBot feature uses which channel/role, from the stored config.
 * Maps snowflake → sorted list of feature labels (`quotes`, `birthdays`, …).
 */
export function mapFeatureBindings(
  config: Record<string, ConfigValue | undefined>,
): { channels: Map<string, string[]>; roles: Map<string, string[]> } {
  const channels = new Map<string, string[]>();
  const roles = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, id: string, label: string): void => {
    const list = map.get(id) ?? [];
    if (!list.includes(label)) list.push(label);
    map.set(id, list);
  };
  for (const [key, raw] of Object.entries(config)) {
    if (typeof raw !== "string" || raw === "") continue;
    const feature = key.split(".")[0] ?? key;
    if (key === "leaderboard_roles.tiers") {
      for (const part of raw.split(",")) {
        const roleId = part.split(":")[1]?.trim();
        if (roleId && SNOWFLAKE.test(roleId)) add(roles, roleId, feature);
      }
      continue;
    }
    if (!BINDING_KEY.test(key)) continue;
    const isRole = /(role_id|_roles)$/.test(key);
    for (const id of snowflakes(raw)) {
      add(isRole ? roles : channels, id, feature);
    }
  }
  return { channels, roles };
}

/**
 * The effective configuration for every known key: the stored value, else
 * the environment fallback, else the schema default. A failed database read
 * throws, so the planner never diffs against a half-read config.
 */
export async function readEffectiveConfig(): Promise<
  Record<string, ConfigValue | undefined>
> {
  const known = defaultConfig as unknown as Record<string, unknown>;
  const rows = await ConfigService.getInstance().getAll();
  const stored = new Map<string, unknown>(rows.map((r) => [r.key, r.value]));
  const out: Record<string, ConfigValue | undefined> = {};
  for (const [key, fallback] of Object.entries(known)) {
    const value = stored.has(key)
      ? stored.get(key)
      : (getEnvConfigValue(key) ?? fallback);
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

/** Infer how the server names its channels (#1019 naming detection). */
export function detectNamingConvention(
  channelNames: string[],
  categoryNames: string[],
): NamingConvention {
  const counts = { emoji: 0, kebab: 0, other: 0 };
  const separators = new Map<string, number>();
  const prefixes = new Map<string, number>();
  const suffixes = new Map<string, number>();
  for (const name of channelNames) {
    const emoji = EMOJI_SEP.exec(name);
    if (emoji) {
      counts.emoji += 1;
      const sep = emoji[1] ?? "";
      separators.set(sep, (separators.get(sep) ?? 0) + 1);
      const lead = name.slice(0, name.indexOf(sep)).trim();
      if (lead) prefixes.set(lead, (prefixes.get(lead) ?? 0) + 1);
    } else if (KEBAB.test(name)) {
      counts.kebab += 1;
    } else {
      counts.other += 1;
    }
    const tail = /\s([\p{Extended_Pictographic}])$/u.exec(name);
    if (tail?.[1]) suffixes.set(tail[1], (suffixes.get(tail[1]) ?? 0) + 1);
  }
  const total = channelNames.length;
  const top = (m: Map<string, number>): [string, number] | null => {
    let best: [string, number] | null = null;
    for (const entry of m) if (!best || entry[1] > best[1]) best = entry;
    return best;
  };
  const categoryEmojiPrefix =
    categoryNames.length > 0 &&
    categoryNames.filter((n) => /^\p{Extended_Pictographic}/u.test(n)).length /
      categoryNames.length >=
      0.5;

  let pattern: NamingConvention["pattern"] = null;
  let confidence = 0;
  if (total > 0) {
    const dominant = Math.max(counts.emoji, counts.kebab, counts.other);
    confidence = dominant / total;
    if (confidence < 0.5) pattern = "mixed";
    else if (dominant === counts.emoji) pattern = "emoji-separator";
    else if (dominant === counts.kebab) pattern = "lower-kebab";
    else pattern = "mixed";
  }
  const sep = pattern === "emoji-separator" ? top(separators) : null;
  const prefix = pattern === "emoji-separator" ? top(prefixes) : null;
  const suffix = top(suffixes);
  return {
    pattern,
    separator: sep?.[0] ?? null,
    confidence: Math.round(confidence * 100) / 100,
    samples: channelNames.slice(0, 5),
    categoryEmojiPrefix,
    suggestedPrefix:
      prefix && sep && prefix[1] >= Math.ceil(total / 2)
        ? `${prefix[0]} ${sep[0]} `
        : null,
    suggestedSuffix:
      suffix && suffix[1] >= Math.ceil(total / 2) ? suffix[0] : null,
  };
}

/**
 * Bits of the scan that need an effective-permission read of the bot. Kept
 * separate so tests can drive the readiness rules without a guild.
 */
export function buildReadiness(input: {
  botUserId: string;
  botRoles: Array<{ id: string; name: string; position: number }>;
  permissionBits: bigint;
  administrator: boolean;
  allRoles: Array<{
    id: string;
    name: string;
    position: number;
    managed: boolean;
    isEveryone: boolean;
  }>;
  roleBindings: Map<string, string[]>;
  membersIntent: boolean;
}): BotReadiness {
  const highest = [...input.botRoles].sort(
    (a, b) => b.position - a.position,
  )[0];
  const highestPosition = highest?.position ?? 0;
  const permissions: PermissionCheck[] = READINESS_PERMISSIONS.map((p) => ({
    name: p.name,
    purpose: p.purpose,
    required: p.required,
    granted: input.administrator || (input.permissionBits & p.flag) === p.flag,
  }));
  const rolesAboveBot = input.allRoles
    .filter((r) => !r.isEveryone && !r.managed && r.position > highestPosition)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, position: r.position }));

  const issues: ReadinessIssue[] = [];
  for (const p of permissions) {
    if (p.granted) continue;
    issues.push({
      code: `missing-${p.name}`,
      severity: p.required ? "error" : "warning",
      message: `KoolBot is missing the ${p.name} permission (${p.purpose}). Grant it to the KoolBot role in Server Settings → Roles.`,
      help: TROUBLESHOOTING,
    });
  }
  const names = rolesAboveBot.slice(0, 5).map((r) => `"${r.name}"`);
  const more = rolesAboveBot.length - names.length;
  if (rolesAboveBot.length > 0) {
    const list = names.join(", ") + (more > 0 ? ` and ${more} more` : "");
    issues.push({
      code: "role-hierarchy-low",
      severity: "warning",
      message: `${rolesAboveBot.length} role(s) sit above KoolBot, which cannot manage them: ${list}. Move the KoolBot role above the roles it should manage in Server Settings → Roles.`,
      help: TROUBLESHOOTING,
    });
  }
  for (const r of rolesAboveBot) {
    const used = input.roleBindings.get(r.id);
    if (!used?.length) continue;
    issues.push({
      code: `bound-role-unmanageable-${r.id}`,
      severity: "error",
      message: `The role "${r.name}" is used by ${used.join(", ")} but sits above KoolBot. Move the KoolBot role above "${r.name}" so it can assign it.`,
      help: TROUBLESHOOTING,
    });
  }
  if (!input.membersIntent) {
    issues.push({
      code: "members-intent-off",
      severity: "info",
      message:
        "The GuildMembers intent is off, so role member counts come from the cache and may be low. Enable it in the Discord developer portal for exact counts.",
      help: TROUBLESHOOTING,
    });
  }
  return {
    botUserId: input.botUserId,
    botRoleIds: input.botRoles.map((r) => r.id),
    highestRoleId: highest?.id ?? null,
    highestRoleName: highest?.name ?? null,
    highestRolePosition: highestPosition,
    roleCount: input.allRoles.length,
    administrator: input.administrator,
    permissions,
    rolesAboveBot,
    membersIntent: input.membersIntent,
    issues,
    ready: !issues.some((i) => i.severity === "error"),
  };
}

export class ServerScanService {
  private static instance: ServerScanService | null = null;

  private constructor(private readonly client: Client) {}

  public static getInstance(client: Client): ServerScanService {
    if (!ServerScanService.instance) {
      ServerScanService.instance = new ServerScanService(client);
    }
    return ServerScanService.instance;
  }

  /** Test hook. */
  public static reset(): void {
    ServerScanService.instance = null;
  }

  /** Scan a guild. Never writes to Discord or the database. */
  public async scan(
    guildId: string,
    options: ScanOptions = {},
  ): Promise<ServerScan> {
    const guild = await this.client.guilds.fetch(guildId);
    return this.scanGuild(guild, options);
  }

  public async scanGuild(
    guild: Guild,
    options: ScanOptions = {},
  ): Promise<ServerScan> {
    const partial: string[] = [];
    const note = (what: string, err: unknown): void => {
      partial.push(what);
      logger.debug(`server scan: ${what}: ${sanitizeForLog(err)}`);
    };

    // Roles, channels, the bot's own member and the config are the planner's
    // baseline: a failed read must abort the scan, not yield a partial one
    // that makes existing roles or channels look absent.
    await guild.roles.fetch();
    await guild.channels.fetch();
    const me = guild.members.me ?? (await guild.members.fetchMe());

    const config = await this.readConfig();
    const bindings = mapFeatureBindings(config);
    const botUserId = this.client.user?.id ?? me?.id ?? "";

    // ----- Discord-owned features -----
    const community = await this.readCommunity(guild, note);
    const onboardingRoleSet = new Set(community.onboardingRoleIds);
    const onboardingChannelSet = new Set(community.onboardingChannelIds);

    // ----- Roles -----
    const botRoleIds = me ? [...me.roles.cache.keys()] : [];
    const botRoles = me
      ? [...me.roles.cache.values()].filter((r) => r.id !== guild.id)
      : [];
    const highestPosition = me?.roles.highest?.position ?? 0;
    const cacheComplete = guild.members.cache.size >= guild.memberCount;
    const roles: ScanRole[] = [...guild.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .map((r) => {
        const isEveryone = r.id === guild.id;
        return {
          id: r.id,
          name: r.name,
          color: colorOf(r),
          position: r.position,
          managed: r.managed,
          isEveryone,
          permissions: permissionNames(r.permissions.bitfield.toString()),
          memberCount: isEveryone ? guild.memberCount : r.members.size,
          memberCountApproximate: !isEveryone && !cacheComplete,
          botId: r.tags?.botId ?? null,
          botCanManage:
            !isEveryone && !r.managed && r.position < highestPosition,
          usedBy: bindings.roles.get(r.id) ?? [],
          onboardingManaged: onboardingRoleSet.has(r.id),
        };
      });
    const roleName = new Map(roles.map((r) => [r.id, r.name]));

    // ----- Webhooks / followed channels -----
    const webhookFed = new Set<string>();
    const followed = new Set<string>();
    try {
      const hooks = await guild.fetchWebhooks();
      for (const h of hooks.values()) {
        if (!h.channelId) continue;
        if (h.type === WebhookType.ChannelFollower) followed.add(h.channelId);
        else webhookFed.add(h.channelId);
      }
    } catch (e) {
      note("webhooks (needs ManageWebhooks)", e);
    }

    // ----- Channels -----
    const allChannels = [...guild.channels.cache.values()].filter(
      (c): c is GuildBasedChannel => Boolean(c) && !c.isThread(),
    );
    const labelFor = (id: string, type: OverwriteType): string => {
      if (type === 0) return roleName.get(id) ?? id;
      return guild.members.cache.get(id)?.displayName ?? id;
    };
    const channels: ScanChannel[] = allChannels
      .sort((a, b) => posOf(a) - posOf(b))
      .map((c) =>
        this.describeChannel(c, guild, {
          labelFor,
          bindings: bindings.channels,
          webhookFed,
          followed,
          onboardingDefault: onboardingChannelSet,
          community,
          afkChannelId: guild.afkChannelId,
        }),
      );

    // ----- Other bots -----
    const bots = this.collectBots(guild, roles, channels, botUserId);

    // ----- Owner hints (opt-in) -----
    if (options.sampleMessages) {
      await this.sampleOwners(guild, channels, options, note);
    }

    // ----- Readiness -----
    const membersIntent = this.hasMembersIntent();
    const botBits = me?.permissions.bitfield ?? 0n;
    const readiness = buildReadiness({
      botUserId,
      botRoles: botRoles.map((r) => ({
        id: r.id,
        name: r.name,
        position: r.position,
      })),
      permissionBits: botBits,
      administrator: (botBits & Administrator) === Administrator,
      allRoles: roles,
      roleBindings: bindings.roles,
      membersIntent,
    });

    // ----- Naming, events, suggestions -----
    const textVoice = channels.filter((c) => c.kind !== "category");
    const naming = detectNamingConvention(
      textVoice.map((c) => c.name),
      channels.filter((c) => c.kind === "category").map((c) => c.name),
    );
    const scheduledEvents = await this.readScheduledEvents(guild, note);
    const suggestions = this.buildSuggestions(guild, config, channels, naming);

    // ----- Planner input -----
    const scanned = await this.buildScannedState({
      guild,
      botUserId,
      botRoleIds,
      highestPosition,
      roles,
      channels,
      bots,
      config,
      boundChannelIds: [...bindings.channels.keys()],
      adminUserId: options.adminUserId,
    });

    return {
      guildId: guild.id,
      guildName: guild.name,
      scannedAt: new Date().toISOString(),
      scanned,
      roles,
      channels,
      bots,
      readiness,
      community,
      naming,
      scheduledEvents,
      suggestions,
      partial,
    };
  }

  private hasMembersIntent(): boolean {
    try {
      return this.client.options.intents.has(GatewayIntentBits.GuildMembers);
    } catch {
      return false;
    }
  }

  private readConfig(): Promise<Record<string, ConfigValue | undefined>> {
    return readEffectiveConfig();
  }

  private describeChannel(
    c: GuildBasedChannel,
    guild: Guild,
    ctx: {
      labelFor: (id: string, type: OverwriteType) => string;
      bindings: Map<string, string[]>;
      webhookFed: Set<string>;
      followed: Set<string>;
      onboardingDefault: Set<string>;
      community: CommunityInfo;
      afkChannelId: string | null;
    },
  ): ScanChannel {
    const overwrites: ScanOverwrite[] =
      "permissionOverwrites" in c && c.permissionOverwrites
        ? [...c.permissionOverwrites.cache.values()].map((o) => ({
            id: o.id,
            type: o.type === 0 ? "role" : "member",
            label: ctx.labelFor(o.id, o.type),
            allow: permissionNames(o.allow.bitfield.toString()),
            deny: permissionNames(o.deny.bitfield.toString()),
          }))
        : [];
    const everyone = overwrites.find((o) => o.id === guild.id);
    const everyoneDeniesView = everyone?.deny.includes("ViewChannel") ?? false;
    const gatedByRoleIds = everyoneDeniesView
      ? overwrites
          .filter(
            (o) =>
              o.type === "role" &&
              o.id !== guild.id &&
              o.allow.includes("ViewChannel"),
          )
          .map((o) => o.id)
      : [];
    const parentId = "parentId" in c ? (c.parentId ?? null) : null;
    const locked =
      "permissionsLocked" in c && typeof c.permissionsLocked === "boolean"
        ? c.permissionsLocked
        : null;
    const name = c.name ?? c.id;
    const guess = FEATURE_NAME_HINTS.find((h) => h.test.test(name));
    return {
      id: c.id,
      name,
      kind: kindOf(c.type),
      typeName: ChannelType[c.type] ?? String(c.type),
      parentId,
      parentName: parentId
        ? (guild.channels.cache.get(parentId)?.name ?? null)
        : null,
      syncedToParent: parentId ? locked : null,
      position: posOf(c),
      overwrites,
      usedBy: ctx.bindings.get(c.id) ?? [],
      featureGuess: guess?.feature ?? null,
      gatedByRoleIds,
      ownerHint: null,
      flags: {
        afk: ctx.afkChannelId === c.id,
        rules: ctx.community.rulesChannelId === c.id,
        system: ctx.community.systemChannelId === c.id,
        publicUpdates: ctx.community.publicUpdatesChannelId === c.id,
        webhookFed: ctx.webhookFed.has(c.id),
        followed: ctx.followed.has(c.id),
        announcement: c.type === ChannelType.GuildAnnouncement,
        forum:
          c.type === ChannelType.GuildForum ||
          c.type === ChannelType.GuildMedia,
        stage: c.type === ChannelType.GuildStageVoice,
        onboardingDefault: ctx.onboardingDefault.has(c.id),
      },
    };
  }

  private collectBots(
    guild: Guild,
    roles: ScanRole[],
    channels: ScanChannel[],
    koolBotId: string,
  ): ScanBot[] {
    const byBot = new Map<string, ScanBot>();
    const get = (userId: string): ScanBot => {
      let bot = byBot.get(userId);
      if (!bot) {
        bot = {
          userId,
          tag: guild.members.cache.get(userId)?.user.tag ?? null,
          roleIds: [],
          overwriteChannelIds: [],
          isKoolBot: userId === koolBotId,
        };
        byBot.set(userId, bot);
      }
      return bot;
    };
    for (const r of roles) if (r.botId) get(r.botId).roleIds.push(r.id);
    for (const m of guild.members.cache.values()) {
      if (m.user.bot) get(m.id);
    }
    for (const bot of byBot.values()) {
      for (const ch of channels) {
        if (
          ch.overwrites.some(
            (o) => o.id === bot.userId || bot.roleIds.includes(o.id),
          )
        ) {
          bot.overwriteChannelIds.push(ch.id);
        }
      }
    }
    return [...byBot.values()];
  }

  private async readCommunity(
    guild: Guild,
    note: (what: string, err: unknown) => void,
  ): Promise<CommunityInfo> {
    const features = [...(guild.features as string[])];
    const info: CommunityInfo = {
      community: features.includes("COMMUNITY"),
      features,
      rulesChannelId: guild.rulesChannelId ?? null,
      systemChannelId: guild.systemChannelId ?? null,
      publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
      onboardingEnabled: null,
      onboardingRoleIds: [],
      onboardingChannelIds: [],
      onboardingPrompts: [],
    };
    if (!info.community) return info;
    try {
      const onboarding = await guild.fetchOnboarding();
      info.onboardingEnabled = onboarding.enabled;
      const roleIds = new Set<string>();
      const channelIds = new Set<string>(onboarding.defaultChannels.keys());
      for (const prompt of onboarding.prompts.values()) {
        const promptRoles = new Set<string>();
        for (const opt of prompt.options.values()) {
          for (const id of opt.roles.keys()) {
            roleIds.add(id);
            promptRoles.add(id);
          }
          for (const id of opt.channels.keys()) channelIds.add(id);
        }
        info.onboardingPrompts.push({
          title: prompt.title,
          roleIds: [...promptRoles],
        });
      }
      info.onboardingRoleIds = [...roleIds];
      info.onboardingChannelIds = [...channelIds];
    } catch (e) {
      note("onboarding", e);
    }
    return info;
  }

  private async readScheduledEvents(
    guild: Guild,
    note: (what: string, err: unknown) => void,
  ): Promise<ScheduledEventInfo[]> {
    try {
      const events = await guild.scheduledEvents.fetch();
      return [...events.values()].map((e) => ({
        id: e.id,
        name: e.name,
        startsAt: e.scheduledStartAt?.toISOString() ?? null,
        status: String(e.status),
        channelId: e.channelId ?? null,
      }));
    } catch (e) {
      note("scheduled events", e);
      return [];
    }
  }

  /** Sample recent authors: flag channels one bot dominates. */
  private async sampleOwners(
    guild: Guild,
    channels: ScanChannel[],
    options: ScanOptions,
    note: (what: string, err: unknown) => void,
  ): Promise<void> {
    const limit = options.sampleChannelLimit ?? 40;
    const textChannels = channels
      .filter((c) => c.kind === "text")
      .slice(0, limit);
    for (const ch of textChannels) {
      const live = guild.channels.cache.get(ch.id);
      if (!live || !("messages" in live)) continue;
      try {
        const msgs = await live.messages.fetch({ limit: 25 });
        if (msgs.size < 5) continue;
        const counts = new Map<string, { n: number; tag: string }>();
        for (const m of msgs.values()) {
          if (!m.author.bot) continue;
          const e = counts.get(m.author.id) ?? { n: 0, tag: m.author.tag };
          e.n += 1;
          counts.set(m.author.id, e);
        }
        let top: [string, { n: number; tag: string }] | null = null;
        for (const entry of counts)
          if (!top || entry[1].n > top[1].n) top = entry;
        if (top && top[1].n / msgs.size >= 0.6) {
          ch.ownerHint = {
            botId: top[0],
            botTag: top[1].tag,
            share: Math.round((top[1].n / msgs.size) * 100) / 100,
          };
        }
      } catch (e) {
        note(`message sample for ${ch.id}`, e);
        break; // permission-style failures repeat; stop rather than spam REST
      }
    }
  }

  private buildSuggestions(
    guild: Guild,
    config: Record<string, ConfigValue | undefined>,
    channels: ScanChannel[],
    naming: NamingConvention,
  ): ScanSuggestion[] {
    const out: ScanSuggestion[] = [];
    if (guild.afkChannelId) {
      const excluded = String(config["voicetracking.excluded_channels"] ?? "");
      if (!snowflakes(excluded).includes(guild.afkChannelId)) {
        const name =
          channels.find((c) => c.id === guild.afkChannelId)?.name ??
          guild.afkChannelId;
        out.push({
          code: "afk-not-excluded",
          message: `The AFK channel "${name}" is not in voicetracking.excluded_channels; add it so idle time is not tracked.`,
        });
      }
    }
    for (const c of channels) {
      if (c.flags.webhookFed || c.flags.followed) {
        out.push({
          code: `fed-channel-${c.id}`,
          message: `"${c.name}" is fed by ${c.flags.followed ? "a followed announcement channel" : "a webhook"}; protect it and consider making it read-only.`,
        });
      }
    }
    if (naming.suggestedPrefix) {
      out.push({
        code: "naming-prefix",
        message: `Channels follow an emoji pattern; consider voicechannels.channel.prefix = "${naming.suggestedPrefix}".`,
      });
    }
    return out;
  }

  private async buildScannedState(input: {
    guild: Guild;
    botUserId: string;
    botRoleIds: string[];
    highestPosition: number;
    roles: ScanRole[];
    channels: ScanChannel[];
    bots: ScanBot[];
    config: Record<string, ConfigValue | undefined>;
    boundChannelIds: string[];
    adminUserId?: string;
  }): Promise<ScannedState> {
    const { guild } = input;
    let adminRoleIds: string[] = [];
    if (input.adminUserId) {
      // The planner's lockout check needs the admin's real roles; an
      // unreadable admin aborts the scan rather than looking role-less.
      const member = await guild.members.fetch(input.adminUserId);
      adminRoleIds = [...member.roles.cache.keys()];
    }
    const roleStates: RoleState[] = input.roles
      .filter((r) => !r.isEveryone)
      .map((r) => {
        const live = guild.roles.cache.get(r.id);
        return {
          id: r.id,
          name: r.name,
          color: r.color,
          permissions: live?.permissions.bitfield.toString() ?? "0",
          position: r.position,
          managed: r.managed,
        };
      });
    // @everyone is a real role in the permission algorithm.
    const everyone = guild.roles.everyone ?? guild.roles.cache.get(guild.id);
    if (everyone) {
      roleStates.push({
        id: everyone.id,
        name: everyone.name,
        color: 0,
        permissions: everyone.permissions.bitfield.toString(),
        position: 0,
        managed: false,
      });
    }
    const channelStates: ChannelState[] = input.channels.map((c) => {
      const live = guild.channels.cache.get(c.id);
      const overwrites: OverwriteState[] =
        live && "permissionOverwrites" in live && live.permissionOverwrites
          ? [...live.permissionOverwrites.cache.values()].map((o) => ({
              id: o.id,
              type: o.type === 0 ? "role" : "member",
              allow: o.allow.bitfield.toString(),
              deny: o.deny.bitfield.toString(),
            }))
          : [];
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        rawType: live?.type,
        parentId: c.parentId,
        position: c.position,
        topic:
          live && "topic" in live && typeof live.topic === "string"
            ? live.topic
            : null,
        overwrites,
        voiceMemberCount:
          live && "members" in live && c.kind === "voice"
            ? ((live.members as { size?: number }).size ?? 0)
            : 0,
      };
    });
    return {
      guildId: guild.id,
      ownerId: guild.ownerId,
      botUserId: input.botUserId,
      botRoleIds: input.botRoleIds,
      botHighestRolePosition: input.highestPosition,
      adminUserId: input.adminUserId ?? "",
      adminRoleIds,
      otherBotIds: input.bots.filter((b) => !b.isKoolBot).map((b) => b.userId),
      roles: roleStates,
      channels: channelStates,
      config: input.config,
      boundChannelIds: input.boundChannelIds,
      koolbotCreatedIds: [],
    };
  }
}
