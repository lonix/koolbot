/**
 * Read-only route handlers for #381. These mount onto the WebUI router built
 * by `createWebRouter` and behind its session middleware. Every page reads
 * through existing services in `src/services/` — no duplicate data access,
 * no writes.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { ChannelType, Client } from "discord.js";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import { defaultConfig, settingsMetadata } from "../services/config-schema.js";
import { PermissionsService } from "../services/permissions-service.js";
import { ScheduledAnnouncementService } from "../services/scheduled-announcement-service.js";
import { ScheduledAnnouncement } from "../models/scheduled-announcement.js";
import {
  EventService,
  formatEventWhen,
  countRsvps,
} from "../services/event-service.js";
import { PollService } from "../services/poll-service.js";
import { PollSchedule } from "../models/poll-schedule.js";
import { PollItem } from "../models/poll-item.js";
import { ReactionRoleService } from "../services/reaction-role-service.js";
import { ReactionRoleConfig } from "../models/reaction-role-config.js";
import Notice from "../models/notice.js";
import { NOTICE_CATEGORIES } from "../content/notice-categories.js";
import { BotStatusMessage } from "../models/bot-status-message.js";
import {
  BOT_STATUS_POOLS,
  BOT_STATUS_POOL_META,
  STATUS_POOL_DEFAULTS,
  STATUS_TEXT_MAX,
} from "../content/statuses.js";
import { VoiceChannelTruncationService } from "../services/voice-channel-truncation.js";
import { DigestService } from "../services/digest-service.js";
import {
  VoiceChannelManager,
  resolveManagedCategory,
} from "../services/voice-channel-manager.js";
import { WebAuditLog } from "../models/web-audit-log.js";
import { DiscordCommandAuditLog } from "../models/discord-command-audit-log.js";
import { getCommandMetricsSummary } from "../services/command-metrics-query.js";
import { getGuildVoiceHeatmap } from "../services/voice-activity-analytics.js";
import { getServerTimezone } from "../utils/timezone.js";
import { BOOTSTRAP_VARS } from "./bootstrap-vars.js";
import { getEnv } from "../config/env.js";
import {
  createSessionPingHandler,
  requireAdminRoleMiddleware,
  type AuthenticatedRequest,
} from "./session.js";
import {
  getDisplayedRemainingMs,
  resolveNavFeatureStatus,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  renderAnalyticsPage,
  renderAnnouncementsPage,
  renderBootstrapPage,
  renderBotStatusPage,
  renderCommandAuditPage,
  renderCommandMetricsPage,
  renderDashboardPage,
  renderDatabasePage,
  renderDigestPage,
  renderEventsPage,
  renderNoticesPage,
  renderPermissionsPage,
  renderPollsPage,
  renderReactionRolesPage,
  renderSettingsPage,
  renderVoiceChannelsPage,
  type ChannelOption,
  type CommandAuditRow,
  type DbTrunkHistoryRow,
  type DigestPreviewView,
  type FlashMessage,
  type NoticeCategoryOption,
  type ReactionRoleRow,
  type RoleOption,
  type SettingRow,
} from "./admin-views.js";

function deriveCategory(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? "other" : key.slice(0, dot);
}

function describeType(value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return typeof value;
}

/**
 * The `voicechannels.*` keys surfaced as editable controls on the Voice
 * Channels feature page (#705). The feature master `voicechannels.enabled`
 * is intentionally excluded — it is owned by the enable/disable notice.
 */
export const VOICE_CHANNELS_SETTING_KEYS = [
  "voicechannels.category_id",
  "voicechannels.lobby.name",
  "voicechannels.lobby.offlinename",
  "voicechannels.channel.prefix",
  "voicechannels.channel.suffix",
  "voicechannels.controlpanel.enabled",
  "voicechannels.presets.enabled",
  "voicechannels.presets.max_per_user",
] as const;

/**
 * Build the {@link SettingRow}s for a fixed list of config keys, mirroring how
 * the Settings page derives label/type/description from `settingsMetadata` with
 * a stored DB row taking precedence. Lets a feature page render its own keys
 * with the shared control renderer (#705).
 */
export function buildSettingRows(
  keys: readonly string[],
  stored: ReadonlyArray<{
    key: string;
    value: unknown;
    description?: string;
    category?: string;
  }>,
): SettingRow[] {
  const storedByKey = new Map(stored.map((s) => [s.key, s]));
  return keys.map((key) => {
    const dbEntry = storedByKey.get(key);
    const meta = settingsMetadata[key as keyof typeof settingsMetadata];
    const defaultValue = defaultConfig[key as keyof typeof defaultConfig];
    return {
      key,
      label: meta?.label ?? key,
      current: dbEntry ? dbEntry.value : defaultValue,
      defaultValue,
      type: meta?.type ?? describeType(defaultValue),
      description: dbEntry?.description ?? meta?.description ?? "",
      category: dbEntry?.category ?? meta?.category ?? deriveCategory(key),
      options: meta?.options,
      warnBelow: meta?.warnBelow,
      channelKind: meta?.channelKind,
    };
  });
}

function getCsrfToken(req: Request): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

async function commonFromReq(req: AuthenticatedRequest): Promise<{
  guildId: string;
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus: NavFeatureStatus;
}> {
  const session = req.webSession;
  if (!session) {
    // The middleware should always populate this; throw to satisfy the type
    // narrower without falling through to a partially-initialised page.
    throw new Error("requireSession middleware must run first");
  }
  const config = ConfigService.getInstance();
  const navFeatureStatus = await resolveNavFeatureStatus((key) =>
    config.getBoolean(key, false),
  );
  return {
    guildId: session.guildId,
    csrfToken: getCsrfToken(req),
    remainingMs: getDisplayedRemainingMs(session),
    navFeatureStatus,
  };
}

interface ChannelData {
  names: Map<string, string>;
  textChannels: ChannelOption[];
  voiceChannels: ChannelOption[];
  categoryChannels: ChannelOption[];
}

interface RoleData {
  names: Map<string, string>;
  roles: RoleOption[];
}

/**
 * Fetch the guild's channel cache once and derive the id→name map plus
 * the option lists used to populate picker dropdowns: text channels for
 * normal channel pickers, voice (+ stage) channels for voice-oriented
 * pickers (e.g. `voicetracking.excluded_channels`, which excludes voice
 * channels a session could be tracked in), and category channels for the
 * voicechannels managed-category picker. At most two Discord API calls per
 * request (the guild fetch, then its channel fetch — both no-ops when already
 * cached).
 */
export async function fetchChannelData(
  client: Client,
  guildId: string,
): Promise<ChannelData> {
  const names = new Map<string, string>();
  const textChannels: ChannelOption[] = [];
  const voiceChannels: ChannelOption[] = [];
  const categoryChannels: ChannelOption[] = [];
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    for (const ch of guild.channels.cache.values()) {
      if (!ch?.id) continue;
      const name = ch.name ?? ch.id;
      names.set(ch.id, name);
      if (
        ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildAnnouncement
      ) {
        textChannels.push({ id: ch.id, name });
      } else if (
        ch.type === ChannelType.GuildVoice ||
        ch.type === ChannelType.GuildStageVoice
      ) {
        voiceChannels.push({ id: ch.id, name });
      } else if (ch.type === ChannelType.GuildCategory) {
        categoryChannels.push({ id: ch.id, name });
      }
    }
    textChannels.sort((a, b) => a.name.localeCompare(b.name));
    voiceChannels.sort((a, b) => a.name.localeCompare(b.name));
    categoryChannels.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    logger.debug("fetchChannelData failed", err);
  }
  return { names, textChannels, voiceChannels, categoryChannels };
}

/**
 * Fetch the guild's roles cache once and return both the id→name map
 * and the picker option list (with @everyone filtered out).
 */
export async function fetchRoleData(
  client: Client,
  guildId: string,
): Promise<RoleData> {
  const names = new Map<string, string>();
  const roles: RoleOption[] = [];
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.roles.fetch();
    for (const role of guild.roles.cache.values()) {
      names.set(role.id, role.name);
      if (role.id === guild.id) continue; // skip @everyone in pickers
      roles.push({ id: role.id, name: role.name });
    }
    roles.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    logger.debug("fetchRoleData failed", err);
  }
  return { names, roles };
}

function readFlash(req: Request): FlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text) return null;
  if (type !== "ok" && type !== "warn" && type !== "err") return null;
  // Cap the rendered message length so a hostile redirect cannot pump
  // megabytes through the banner. Pages already escape on output.
  return { type, text: text.slice(0, 500) };
}

/**
 * Wrap an async handler so any rejected promise propagates to Express'
 * error pipeline instead of triggering an UnhandledPromiseRejection.
 */
function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

export function createReadOnlyRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();

  // Session ping (#435). Mounted BEFORE `requireSession` because the
  // ping is a read-only status query and must NOT itself bump the
  // session's `act` timestamp — otherwise polling every 30s would keep
  // an idle session alive forever, defeating the inactivity window.
  // The handler runs its own (non-mutating) cookie + DB validation.
  router.get("/session/ping", createSessionPingHandler());

  router.use(requireSession);
  // Every `/admin/*` page below this point is admin-only. User-role
  // sessions get a 403 page that points them at `/me/` (#481).
  router.use(requireAdminRoleMiddleware());

  // ---------- Dashboard ----------
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();

      let guildName: string | null = null;
      let memberCount: number | null = null;
      let voiceUsers: number | null = null;
      try {
        const guild = await client.guilds.fetch(common.guildId);
        guildName = guild.name;
        memberCount = guild.memberCount;
        voiceUsers = guild.voiceStates.cache.filter(
          (s) => s.channelId !== null,
        ).size;
      } catch (err) {
        logger.debug("dashboard guild fetch failed", err);
      }

      const featureKeys: Array<{ key: string; label: string }> = [
        { key: "voicechannels.enabled", label: "Voice Channels" },
        { key: "voicetracking.enabled", label: "Voice Tracking" },
        { key: "quotes.enabled", label: "Quotes" },
        { key: "achievements.enabled", label: "Achievements" },
        { key: "announcements.enabled", label: "Announcements" },
        { key: "polls.enabled", label: "Polls" },
        { key: "reactionroles.enabled", label: "Reaction Roles" },
        { key: "notices.enabled", label: "Notices" },
      ];
      const features = await Promise.all(
        featureKeys.map(async (f) => ({
          ...f,
          on: await config.getBoolean(f.key, false),
        })),
      );

      const [announcements, pollSchedules, pollItems, reactionRoles, notices] =
        await Promise.all([
          ScheduledAnnouncement.countDocuments({
            guildId: common.guildId,
          }).catch(() => 0),
          PollSchedule.countDocuments({ guildId: common.guildId }).catch(
            () => 0,
          ),
          PollItem.countDocuments({ guildId: common.guildId }).catch(() => 0),
          ReactionRoleConfig.countDocuments({
            guildId: common.guildId,
            isArchived: false,
          }).catch(() => 0),
          Notice.countDocuments({}).catch(() => 0),
        ]);

      const mongoState =
        ["disconnected", "connected", "connecting", "disconnecting"][
          mongoose.connection.readyState
        ] ?? "unknown";

      res.type("text/html").send(
        renderDashboardPage({
          ...common,
          guild: {
            id: common.guildId,
            name: guildName,
            memberCount,
            voiceUsers,
            botTag: client.user?.tag ?? null,
          },
          mongoState,
          counts: {
            announcements,
            pollSchedules,
            pollItems,
            reactionRoles,
            notices,
          },
          features,
        }),
      );
    }),
  );

  // ---------- Bootstrap ----------
  router.get(
    "/bootstrap",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const grouped = new Map<
        string,
        Array<{
          key: string;
          present: boolean;
          isSecret: boolean;
          display?: string;
        }>
      >();
      for (const v of BOOTSTRAP_VARS) {
        const raw = getEnv(v.key);
        const present = typeof raw === "string" && raw.length > 0;
        let display: string | undefined;
        if (present && raw) {
          if (v.isSecret) {
            // Only reveal a 4-char tail when long enough that the tail
            // isn't the whole value. Mirrors the scaffold's behaviour.
            display = raw.length >= 8 ? `…${raw.slice(-4)}` : undefined;
          } else if (raw.length > 32) {
            display = `${raw.slice(0, 28)}…`;
          } else {
            display = raw;
          }
        }
        const arr = grouped.get(v.category) ?? [];
        arr.push({ key: v.key, present, isSecret: v.isSecret, display });
        grouped.set(v.category, arr);
      }
      const groups = Array.from(grouped.entries()).map(([category, rows]) => ({
        category,
        rows,
      }));
      res.type("text/html").send(renderBootstrapPage({ ...common, groups }));
    }),
  );

  // ---------- Settings ----------
  router.get(
    "/settings",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();
      const stored = await config.getAll().catch(() => []);
      const storedByKey = new Map(stored.map((s) => [s.key, s]));

      // Description and category come from the static settingsMetadata
      // map (one entry per key in `defaultConfig`); when a DB row exists
      // and overrides them, prefer the DB value. This way every key has a
      // stable description on a fresh install — even before /config set
      // ever runs — without losing operator-customised descriptions.
      // `type` comes from settingsMetadata when present (the typed config
      // schema is authoritative) and falls back to runtime-inferred type
      // for orphan DB rows that the schema doesn't know about.
      const rows: SettingRow[] = Object.entries(defaultConfig).map(
        ([key, defaultValue]) => {
          const dbEntry = storedByKey.get(key);
          const meta = settingsMetadata[key as keyof typeof settingsMetadata];
          return {
            key,
            label: meta?.label ?? key,
            current: dbEntry ? dbEntry.value : defaultValue,
            defaultValue,
            type: meta?.type ?? describeType(defaultValue),
            description: dbEntry?.description ?? meta?.description ?? "",
            category:
              dbEntry?.category ?? meta?.category ?? deriveCategory(key),
            options: meta?.options,
            warnBelow: meta?.warnBelow,
            channelKind: meta?.channelKind,
          };
        },
      );
      for (const entry of stored) {
        if (!(entry.key in defaultConfig)) {
          rows.push({
            key: entry.key,
            label: entry.key,
            current: entry.value,
            defaultValue: undefined,
            type: describeType(entry.value),
            description: entry.description ?? "",
            category: entry.category ?? "other",
          });
        }
      }
      rows.sort((a, b) =>
        a.category === b.category
          ? a.key.localeCompare(b.key)
          : a.category.localeCompare(b.category),
      );

      const grouped = new Map<string, SettingRow[]>();
      for (const row of rows) {
        const arr = grouped.get(row.category) ?? [];
        arr.push(row);
        grouped.set(row.category, arr);
      }
      const groups = Array.from(grouped.entries()).map(([category, rs]) => ({
        category,
        rows: rs,
      }));

      // Guild cache for the dropdown selectors. One fetch, four lists.
      const { textChannels, voiceChannels, categoryChannels, roles } =
        await Promise.all([
          fetchChannelData(client, common.guildId),
          fetchRoleData(client, common.guildId),
        ]).then(([chData, roleData]) => ({
          textChannels: chData.textChannels,
          voiceChannels: chData.voiceChannels,
          categoryChannels: chData.categoryChannels,
          roles: roleData.roles,
        }));

      // Guild name backs the "type to confirm" step of the danger-zone
      // reset. Best-effort: when the fetch fails the renderer falls back to
      // the guild id, which the reset handler also accepts.
      let guildName: string | null = null;
      try {
        const guild = await client.guilds.fetch(common.guildId);
        guildName = guild.name;
      } catch (err) {
        logger.debug("settings guild fetch failed", err);
      }

      res.type("text/html").send(
        renderSettingsPage({
          ...common,
          groups,
          textChannels,
          voiceChannels,
          categoryChannels,
          roles,
          guildId: common.guildId,
          guildName,
        }),
      );
    }),
  );

  // ---------- Permissions ----------
  router.get(
    "/permissions",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const permissions = PermissionsService.getInstance(client);
      const all = await permissions.listAllPermissions(common.guildId);
      const commands = Array.from(client.commands.keys()).sort();
      const { names: roleNames, roles: guildRoles } = await fetchRoleData(
        client,
        common.guildId,
      );

      const perCommand = new Map<string, string[]>();
      const restrictedRoleIds = new Set<string>();
      for (const entry of all) {
        perCommand.set(entry.commandName, entry.roleIds);
        for (const r of entry.roleIds) restrictedRoleIds.add(r);
      }
      const roleIds = Array.from(restrictedRoleIds).sort((a, b) =>
        (roleNames.get(a) ?? a).localeCompare(roleNames.get(b) ?? b),
      );
      const allRoleIds = guildRoles.map((r) => r.id);

      res.type("text/html").send(
        renderPermissionsPage({
          ...common,
          commands,
          roleIds,
          allRoleIds,
          roleNames,
          perCommand,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Announcements ----------
  router.get(
    "/announcements",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const service = ScheduledAnnouncementService.getInstance(client);
      const config = ConfigService.getInstance();
      const [enabled, announcements, channelData] = await Promise.all([
        config.getBoolean("announcements.enabled", false),
        service.listAnnouncements(common.guildId),
        fetchChannelData(client, common.guildId),
      ]);

      const rows = announcements.map((a) => ({
        id: String(a._id),
        channelName: channelData.names.get(a.channelId) ?? a.channelId,
        cron: a.cronSchedule,
        enabled: a.enabled,
        messagePreview:
          a.message.length > 80 ? `${a.message.slice(0, 80)}…` : a.message,
        embedTitle: a.embedData?.title ?? null,
        placeholders: a.placeholders,
        createdAt: new Date(a.createdAt).toISOString(),
      }));

      res.type("text/html").send(
        renderAnnouncementsPage({
          ...common,
          enabled,
          rows,
          textChannels: channelData.textChannels,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Events ----------
  router.get(
    "/events",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const service = EventService.getInstance(client);
      const config = ConfigService.getInstance();
      const [enabled, categoryId, announcementChannelId, tz, events] =
        await Promise.all([
          config.getBoolean("events.enabled", false),
          config.getString("events.category_id", ""),
          config.getString("events.announcement_channel_id", ""),
          config.getString("events.timezone", ""),
          service.listEvents(common.guildId),
        ]);

      const rows = events.map((e) => {
        const counts = countRsvps(e.rsvps);
        return {
          id: String(e._id),
          title: e.title,
          when: formatEventWhen(e),
          state: e.state,
          going: counts.going,
          maybe: counts.maybe,
          cant: counts.cant,
          channelId: e.channelId,
        };
      });

      res.type("text/html").send(
        renderEventsPage({
          ...common,
          enabled,
          categoryConfigured: categoryId.length > 0,
          announcementConfigured: announcementChannelId.length > 0,
          timezone: tz || getServerTimezone(),
          rows,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Polls ----------
  router.get(
    "/polls",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const service = PollService.getInstance(client);
      const config = ConfigService.getInstance();
      const [
        enabled,
        schedules,
        items,
        defaultDurationHours,
        cooldownDays,
        channelData,
        roleData,
      ] = await Promise.all([
        config.getBoolean("polls.enabled", false),
        service.listSchedules(common.guildId),
        service.listPollItems(common.guildId),
        config.getNumber("polls.default_duration_hours", 24),
        config.getNumber("polls.cooldown_days", 7),
        fetchChannelData(client, common.guildId),
        fetchRoleData(client, common.guildId),
      ]);

      res.type("text/html").send(
        renderPollsPage({
          ...common,
          enabled,
          defaultDurationHours,
          cooldownDays,
          textChannels: channelData.textChannels,
          roles: roleData.roles,
          flash: readFlash(req),
          schedules: schedules.map((s) => ({
            id: String(s._id),
            channelId: s.channelId,
            channelName: channelData.names.get(s.channelId) ?? s.channelId,
            cron: s.cronSchedule,
            durationHours: s.pollDuration,
            pingRoleId: s.roleIdToPing ?? null,
            pingRoleName: s.roleIdToPing
              ? (roleData.names.get(s.roleIdToPing) ?? s.roleIdToPing)
              : null,
            enabled: s.enabled,
            lastRun: s.lastRun ? new Date(s.lastRun).toISOString() : "—",
          })),
          items: items.map((it) => ({
            id: String(it._id),
            question: it.question,
            answers: it.answers ?? [],
            tags: it.tags ?? [],
            multiSelect: it.multiSelect,
            usageCount: it.usageCount,
            lastUsed: it.lastUsed ? new Date(it.lastUsed).toISOString() : "—",
            enabled: it.enabled,
            source: it.source,
          })),
        }),
      );
    }),
  );

  // ---------- Reaction Roles ----------
  router.get(
    "/reaction-roles",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();
      const service = ReactionRoleService.getInstance(client);
      const [enabled, configChannelId, all, archived, channelData] =
        await Promise.all([
          config.getBoolean("reactionroles.enabled", false),
          config.getString("reactionroles.message_channel_id", ""),
          service.listReactionRoles(common.guildId),
          ReactionRoleConfig.find({ guildId: common.guildId, isArchived: true })
            .sort({ archivedAt: -1 })
            .limit(50)
            .lean(),
          fetchChannelData(client, common.guildId),
        ]);
      const channelNames = channelData.names;

      const active = all.filter((rr) => !rr.isArchived);
      const shape = (rr: {
        emoji: string;
        roleName: string;
        roleId: string;
        categoryId: string;
        channelId: string;
        messageId: string;
        isArchived: boolean;
        archivedAt?: Date | null;
      }): ReactionRoleRow => ({
        emoji: rr.emoji,
        roleName: rr.roleName,
        roleId: rr.roleId,
        categoryName: channelNames.get(rr.categoryId) ?? rr.categoryId,
        channelName: channelNames.get(rr.channelId) ?? rr.channelId,
        messageId: rr.messageId,
        isArchived: rr.isArchived,
        archivedAt: rr.archivedAt
          ? new Date(rr.archivedAt).toISOString()
          : null,
      });

      res.type("text/html").send(
        renderReactionRolesPage({
          ...common,
          enabled,
          configChannel: configChannelId
            ? {
                name: channelNames.get(configChannelId) ?? configChannelId,
                id: configChannelId,
              }
            : null,
          active: active.map(shape),
          archived: archived.map(shape),
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Notices ----------
  router.get(
    "/notices",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();
      const [enabled, channelId, headerEnabled, notices, channelData] =
        await Promise.all([
          config.getBoolean("notices.enabled", false),
          config.getString("notices.channel_id", ""),
          config.getBoolean("notices.header_enabled", true),
          Notice.find({}).sort({ category: 1, order: 1 }).lean(),
          fetchChannelData(client, common.guildId),
        ]);
      const channelNames = channelData.names;

      const grouped = new Map<string, typeof notices>();
      for (const n of notices) {
        const arr = grouped.get(n.category) ?? [];
        arr.push(n);
        grouped.set(n.category, arr);
      }
      const groups = Array.from(grouped.entries()).map(([category, list]) => ({
        category,
        rows: list.map((n) => ({
          id: String(n._id),
          order: n.order,
          title: n.title,
          content: n.content,
          preview:
            n.content.length > 120 ? `${n.content.slice(0, 120)}…` : n.content,
          category: n.category,
          messageId: n.messageId ?? "",
          updatedAt: new Date(n.updatedAt).toISOString(),
        })),
      }));

      const categoryOptions: NoticeCategoryOption[] = Object.entries(
        NOTICE_CATEGORIES,
      ).map(([value, info]) => ({
        value,
        label: `${info.emoji} ${info.label}`,
      }));

      res.type("text/html").send(
        renderNoticesPage({
          ...common,
          enabled,
          channel: channelId
            ? { name: channelNames.get(channelId) ?? channelId, id: channelId }
            : null,
          headerEnabled,
          total: notices.length,
          groups,
          categoryOptions,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Bot Status (issue #557) ----------
  router.get(
    "/bot-status",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const rows = await BotStatusMessage.find({ guildId: common.guildId })
        .sort({ pool: 1, order: 1 })
        .lean();

      const pools = BOT_STATUS_POOLS.map((pool) => {
        const meta = BOT_STATUS_POOL_META[pool];
        const items = rows
          .filter((r) => r.pool === pool)
          .map((r) => ({
            id: String(r._id),
            order: r.order,
            text: r.text,
          }));
        const usingDefaults = items.length === 0;
        // The export textarea shows the effective list: stored entries when
        // present, otherwise the built-in defaults the bot is actually using.
        const effective = usingDefaults
          ? [...STATUS_POOL_DEFAULTS[pool]]
          : items.map((i) => i.text);
        return {
          pool,
          label: meta.label,
          description: meta.description,
          requiresCount: meta.requiresCount,
          items,
          usingDefaults,
          exportText: effective.join("\n"),
        };
      });

      res.type("text/html").send(
        renderBotStatusPage({
          ...common,
          maxLength: STATUS_TEXT_MAX,
          pools,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Database ----------
  router.get(
    "/database",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const truncation = VoiceChannelTruncationService.getInstance(client);
      const config = ConfigService.getInstance();
      const status = truncation.getStatus();

      const [enabled, schedule, detailedDays, monthlyMonths, yearlyYears] =
        await Promise.all([
          truncation.isEnabled(),
          truncation.getSchedule(),
          config.getNumber(
            "voicetracking.cleanup.retention.detailed_sessions_days",
            400,
          ),
          config.getNumber(
            "voicetracking.cleanup.retention.monthly_summaries_months",
            6,
          ),
          config.getNumber(
            "voicetracking.cleanup.retention.yearly_summaries_years",
            1,
          ),
        ]);

      const collections: Array<{ name: string; count: number }> = [];
      if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
        try {
          const list = await mongoose.connection.db.listCollections().toArray();
          for (const c of list) {
            try {
              const count = await mongoose.connection.db
                .collection(c.name)
                .estimatedDocumentCount();
              collections.push({ name: c.name, count });
            } catch (err) {
              logger.debug(`collection count failed for ${c.name}`, err);
            }
          }
          collections.sort((a, b) => a.name.localeCompare(b.name));
        } catch (err) {
          logger.debug("listCollections failed", err);
        }
      }

      const stateLabel =
        ["disconnected", "connected", "connecting", "disconnecting"][
          mongoose.connection.readyState
        ] ?? "unknown";

      const historyDocs = await WebAuditLog.find({
        guildId: common.guildId,
        action: "dbtrunk.run",
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
        .catch(() => [] as Array<Record<string, unknown>>);

      const trunkHistory: DbTrunkHistoryRow[] = historyDocs.map((h) => {
        const details = (h.details ?? {}) as {
          sessionsRemoved?: number;
          dataAggregated?: number;
          executionTime?: number;
          errors?: number;
        };
        return {
          ranAt:
            h.createdAt instanceof Date
              ? h.createdAt.toISOString()
              : String(h.createdAt ?? ""),
          sessionsRemoved: details.sessionsRemoved ?? 0,
          dataAggregated: details.dataAggregated ?? 0,
          executionMs: details.executionTime ?? 0,
          errors: details.errors ?? 0,
          result: (h.result as "success" | "failure") ?? "success",
          errorMessage: (h.errorMessage as string | null) ?? null,
        };
      });

      res.type("text/html").send(
        renderDatabasePage({
          ...common,
          connection: {
            state: stateLabel,
            name: mongoose.connection.name ?? "(unknown)",
            host: mongoose.connection.host ?? "(unknown)",
          },
          trunk: {
            enabled,
            schedule: schedule ?? "",
            isScheduled: status.isScheduled,
            isRunning: status.isRunning,
            lastRun: status.lastCleanupDate
              ? status.lastCleanupDate.toISOString()
              : "—",
            detailedDays,
            monthlyMonths,
            yearlyYears,
          },
          trunkHistory,
          collections,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Voice Channels ----------
  router.get(
    "/voice-channels",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();
      const manager = VoiceChannelManager.getInstance(client);

      const [
        enabled,
        controlPanelEnabled,
        lobbyName,
        offlineLobbyName,
        prefix,
        stored,
      ] = await Promise.all([
        config.getBoolean("voicechannels.enabled", false),
        config.getBoolean("voicechannels.controlpanel.enabled", true),
        config.getString("voicechannels.lobby.name", "Lobby"),
        config.getString("voicechannels.lobby.offlinename", "Offline Lobby"),
        config.getString("voicechannels.channel.prefix", "🎮"),
        config.getAll().catch(() => []),
      ]);
      // Editable `voicechannels.*` settings rendered in place on this page
      // (#705), built the same way the Settings page builds its rows.
      const settingRows = buildSettingRows(VOICE_CHANNELS_SETTING_KEYS, stored);
      // Resolved below from the configured `voicechannels.category_id`;
      // falls back to "(not configured)" so the renderer always has
      // a string to show.
      let categoryName = "(not configured)";

      let categoryFound = false;
      let totalManaged = 0;
      let totalEmpty = 0;
      // Category picker options for the editable `voicechannels.category_id`
      // control (#705). Derived from the same guild fetch that builds the
      // managed-channel table below, so the page fetches the guild/channels
      // once rather than paying for a second round-trip.
      const categoryChannels: ChannelOption[] = [];
      const channels: Array<{
        name: string;
        isLobby: boolean;
        isLive: boolean;
        memberCount: number;
        customName: string | null;
        channelId: string;
      }> = [];

      try {
        const guild = await client.guilds.fetch(common.guildId);
        await guild.channels.fetch();
        for (const ch of guild.channels.cache.values()) {
          if (ch?.type === ChannelType.GuildCategory) {
            categoryChannels.push({ id: ch.id, name: ch.name ?? ch.id });
          }
        }
        categoryChannels.sort((a, b) => a.name.localeCompare(b.name));
        const category = await resolveManagedCategory(guild);

        if (category) {
          categoryFound = true;
          categoryName = category.name;
          const voice = Array.from(category.children.cache.values())
            .filter((c) => c.type === ChannelType.GuildVoice)
            .sort((a, b) => a.name.localeCompare(b.name));
          totalManaged = voice.length;
          for (const ch of voice) {
            const memberCount =
              "members" in ch && ch.members ? ch.members.size : 0;
            if (memberCount === 0) totalEmpty += 1;
            channels.push({
              name: ch.name,
              isLobby: ch.name === lobbyName || ch.name === offlineLobbyName,
              isLive: manager.isLive(ch.id),
              memberCount,
              customName: manager.getCustomChannelName(ch.id) ?? null,
              channelId: ch.id,
            });
          }
        }
      } catch (err) {
        logger.debug("voice channels guild fetch failed", err);
      }

      res.type("text/html").send(
        renderVoiceChannelsPage({
          ...common,
          enabled,
          controlPanelEnabled,
          categoryName,
          lobbyName,
          offlineLobbyName,
          prefix,
          totalManaged,
          totalEmpty,
          channels,
          categoryFound,
          settingRows,
          categoryChannels,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Weekly Digest (#539) ----------
  router.get(
    "/digest",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();

      const [
        enabled,
        cron,
        minActiveMinutes,
        streakMinMinutes,
        includeAchievements,
      ] = await Promise.all([
        config.getBoolean("digest.enabled", false),
        config.getString("digest.cron", "0 9 * * 1"),
        config.getNumber("digest.min_active_minutes", 30),
        config.getNumber("digest.streak_min_minutes", 30),
        config.getBoolean("digest.include_achievements", true),
      ]);

      // Preview is a read-only dry run, so it's GET-driven: the "Preview"
      // button submits `?preview=1` and we render the embeds inline. Nothing
      // is sent or written, so it's safe to refresh/bookmark.
      let preview: DigestPreviewView | null = null;
      if (req.query.preview === "1" && enabled) {
        try {
          const result =
            await DigestService.getInstance(client).previewDigest();
          preview = {
            generatedAt: result.generatedAt.toISOString(),
            weekRange: result.weekRange,
            qualifying: result.qualifying,
            optedIn: result.optedIn,
            skippedOptOut: result.skippedOptOut,
            alreadySentAt: result.alreadySentAt
              ? result.alreadySentAt.toISOString()
              : null,
            includeAchievements: result.includeAchievements,
            limit: result.limit,
            entries: result.entries.map((e) => ({
              username: e.username,
              rank: e.rank,
              title: e.title,
              description: e.description,
              fields: e.fields,
              footer: e.footer,
            })),
          };
        } catch (err) {
          logger.error("digest preview failed", err);
        }
      }

      res.type("text/html").send(
        renderDigestPage({
          ...common,
          enabled,
          cron,
          minActiveMinutes,
          streakMinMinutes,
          includeAchievements,
          preview,
          flash: readFlash(req),
        }),
      );
    }),
  );

  // ---------- Command Metrics (#648) ----------
  router.get(
    "/metrics",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();

      // Only the two documented windows are accepted; anything else falls
      // back to 30 so a hand-edited query string can't request an
      // unbounded scan.
      const windowRaw = Number.parseInt(String(req.query.window ?? "30"), 10);
      const windowDays = windowRaw === 7 ? 7 : 30;

      const [enabled, retentionDays, summary] = await Promise.all([
        config.getBoolean("monitoring.metrics_persistence.enabled", true),
        config.getNumber("monitoring.metrics_retention_days", 30),
        getCommandMetricsSummary(common.guildId, windowDays).catch((err) => {
          logger.debug("command metrics aggregation failed", err);
          return {
            windowDays,
            fromDate: "",
            rows: [],
            dailyTotals: [],
            totalUsage: 0,
            totalErrors: 0,
          };
        }),
      ]);

      res.type("text/html").send(
        renderCommandMetricsPage({
          ...common,
          enabled,
          retentionDays,
          windowDays,
          totalUsage: summary.totalUsage,
          totalErrors: summary.totalErrors,
          rows: summary.rows.map((r) => ({
            command: r.command,
            usageCount: r.usageCount,
            errorCount: r.errorCount,
            errorRate: r.errorRate,
            avgResponseMs: r.avgResponseMs,
            lastUsedAt: r.lastUsedAt,
          })),
          dailyTotals: summary.dailyTotals,
        }),
      );
    }),
  );

  // ---------- Voice Analytics (#675, Part B) ----------
  router.get(
    "/analytics",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();

      // Only the three documented windows are accepted; anything else falls
      // back to 90 so a hand-edited query string can't request an unbounded
      // scan. 90 is the default because guild-wide weekly patterns need a few
      // weeks of data to read clearly.
      const windowRaw = Number.parseInt(String(req.query.window ?? "90"), 10);
      const windowDays =
        windowRaw === 7 || windowRaw === 30 || windowRaw === 90
          ? windowRaw
          : 90;

      const enabled = await config.getBoolean("voicetracking.enabled", false);
      const end = new Date();
      const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const heatmap = await getGuildVoiceHeatmap(
        start,
        end,
        getServerTimezone(),
      );

      res.type("text/html").send(
        renderAnalyticsPage({
          ...common,
          enabled,
          windowDays,
          heatmap,
        }),
      );
    }),
  );

  // ---------- Command Audit Log (#459) ----------
  router.get(
    "/audit/commands",
    asyncHandler(async (req, res) => {
      const common = await commonFromReq(req);
      const config = ConfigService.getInstance();

      const pageSize = 50;
      const pageRaw = Number.parseInt(String(req.query.page ?? "1"), 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

      const commandFilter = String(req.query.command ?? "").trim();
      const userFilter = String(req.query.user ?? "").trim();
      const resultFilterRaw = String(req.query.result ?? "").trim();
      const resultFilter =
        resultFilterRaw === "success" ||
        resultFilterRaw === "error" ||
        resultFilterRaw === "denied"
          ? resultFilterRaw
          : "";
      const fromFilter = String(req.query.from ?? "").trim();
      const toFilter = String(req.query.to ?? "").trim();

      const query: Record<string, unknown> = { guildId: common.guildId };
      if (commandFilter) query.commandName = commandFilter;
      if (userFilter) query.discordUserId = userFilter;
      if (resultFilter) query.result = resultFilter;

      const dateRange: Record<string, Date> = {};
      const parsedFrom = fromFilter ? new Date(fromFilter) : null;
      const parsedTo = toFilter ? new Date(toFilter) : null;
      if (parsedFrom && !Number.isNaN(parsedFrom.getTime())) {
        dateRange.$gte = parsedFrom;
      }
      if (parsedTo && !Number.isNaN(parsedTo.getTime())) {
        // Treat `to` as inclusive end-of-day so date pickers behave intuitively.
        const inclusive = new Date(parsedTo);
        inclusive.setHours(23, 59, 59, 999);
        dateRange.$lte = inclusive;
      }
      if (Object.keys(dateRange).length > 0) {
        query.createdAt = dateRange;
      }

      const [enabled, retentionDays, total, docs] = await Promise.all([
        config.getBoolean("core.command_audit.enabled", true),
        config.getNumber("core.command_audit.retention_days", 90),
        DiscordCommandAuditLog.countDocuments(query).catch(() => 0),
        DiscordCommandAuditLog.find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .lean()
          .catch(() => [] as Array<Record<string, unknown>>),
      ]);

      // Resolve user labels from the guild member cache so the table
      // shows names rather than raw snowflakes. One fetch per request.
      const userIdsOnPage = new Set<string>();
      for (const d of docs) {
        if (typeof d.discordUserId === "string") {
          userIdsOnPage.add(d.discordUserId);
        }
      }
      const userLabels = new Map<string, string>();
      try {
        const guild = await client.guilds.fetch(common.guildId);
        for (const id of userIdsOnPage) {
          try {
            const member = await guild.members.fetch(id);
            userLabels.set(id, member.displayName ?? member.user.username);
          } catch {
            // Member left the guild or fetch failed; fall back to ID.
          }
        }
      } catch (err) {
        logger.debug("audit page user-label fetch failed", err);
      }

      const channelData = await fetchChannelData(client, common.guildId);

      const rows: CommandAuditRow[] = docs.map((d) => {
        const userId = String(d.discordUserId ?? "");
        const channelId = typeof d.channelId === "string" ? d.channelId : null;
        return {
          createdAt:
            d.createdAt instanceof Date
              ? d.createdAt.toISOString()
              : String(d.createdAt ?? ""),
          discordUserId: userId,
          userLabel: userLabels.get(userId) ?? userId,
          commandName: String(d.commandName ?? ""),
          subcommand: typeof d.subcommand === "string" ? d.subcommand : null,
          channelId,
          channelLabel: channelId
            ? (channelData.names.get(channelId) ?? channelId)
            : null,
          result: (d.result as "success" | "error" | "denied") ?? "success",
          errorMessage:
            typeof d.errorMessage === "string" ? d.errorMessage : null,
          durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
        };
      });

      const commandOptions = Array.from(client.commands.keys()).sort();
      const userOptions = Array.from(userIdsOnPage)
        .sort()
        .map((id) => ({ id, label: userLabels.get(id) ?? id }));

      res.type("text/html").send(
        renderCommandAuditPage({
          ...common,
          enabled,
          retentionDays,
          commandOptions,
          userOptions,
          filters: {
            commandName: commandFilter,
            userId: userFilter,
            result: resultFilter,
            from: fromFilter,
            to: toFilter,
          },
          rows,
          total,
          page,
          pageSize,
        }),
      );
    }),
  );

  return router;
}
