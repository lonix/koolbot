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
import {
  CategoryChannel,
  ChannelType,
  Client,
  type GuildBasedChannel,
} from "discord.js";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import { defaultConfig } from "../services/config-schema.js";
import { PermissionsService } from "../services/permissions-service.js";
import { ScheduledAnnouncementService } from "../services/scheduled-announcement-service.js";
import { ScheduledAnnouncement } from "../models/scheduled-announcement.js";
import { PollService } from "../services/poll-service.js";
import { PollSchedule } from "../models/poll-schedule.js";
import { PollItem } from "../models/poll-item.js";
import { ReactionRoleService } from "../services/reaction-role-service.js";
import { ReactionRoleConfig } from "../models/reaction-role-config.js";
import Notice from "../models/notice.js";
import { VoiceChannelTruncationService } from "../services/voice-channel-truncation.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import type { AuthenticatedRequest } from "./session.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import {
  renderAnnouncementsPage,
  renderBootstrapPage,
  renderDashboardPage,
  renderDatabasePage,
  renderNoticesPage,
  renderPermissionsPage,
  renderPollsPage,
  renderReactionRolesPage,
  renderSettingsPage,
  renderVoiceChannelsPage,
  type SettingRow,
} from "./admin-views.js";

interface BootstrapEnvVar {
  key: string;
  category: "Discord" | "Database" | "Process" | "WebUI";
  isSecret: boolean;
}

const BOOTSTRAP_VARS: BootstrapEnvVar[] = [
  { key: "DISCORD_TOKEN", category: "Discord", isSecret: true },
  { key: "CLIENT_ID", category: "Discord", isSecret: false },
  { key: "GUILD_ID", category: "Discord", isSecret: false },
  { key: "MONGODB_URI", category: "Database", isSecret: true },
  { key: "NODE_ENV", category: "Process", isSecret: false },
  { key: "DEBUG", category: "Process", isSecret: false },
  { key: "WEBUI_ENABLED", category: "WebUI", isSecret: false },
  { key: "WEBUI_BASE_URL", category: "WebUI", isSecret: false },
  { key: "WEBUI_SESSION_SECRET", category: "WebUI", isSecret: true },
  { key: "WEBUI_SESSION_TTL_MINUTES", category: "WebUI", isSecret: false },
  {
    key: "WEBUI_INACTIVITY_TIMEOUT_MINUTES",
    category: "WebUI",
    isSecret: false,
  },
];

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

function getCsrfToken(req: Request): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

function commonFromReq(req: AuthenticatedRequest): {
  guildId: string;
  csrfToken: string;
  remainingMs: number;
} {
  const session = req.webSession;
  if (!session) {
    // The middleware should always populate this; throw to satisfy the type
    // narrower without falling through to a partially-initialised page.
    throw new Error("requireSession middleware must run first");
  }
  return {
    guildId: session.guildId,
    csrfToken: getCsrfToken(req),
    remainingMs: getDisplayedRemainingMs(),
  };
}

async function fetchChannelNames(
  client: Client,
  guildId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    for (const ch of guild.channels.cache.values()) {
      if (ch?.id) out.set(ch.id, ch.name ?? ch.id);
    }
  } catch (err) {
    logger.debug("fetchChannelNames failed", err);
  }
  return out;
}

async function fetchRoleNames(
  client: Client,
  guildId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.roles.fetch();
    for (const role of guild.roles.cache.values()) {
      out.set(role.id, role.name);
    }
  } catch (err) {
    logger.debug("fetchRoleNames failed", err);
  }
  return out;
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
  router.use(requireSession);

  // ---------- Dashboard ----------
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
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
        { key: "fun.friendship", label: "Friendship" },
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
      const common = commonFromReq(req);
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
        const raw = process.env[v.key];
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
      const common = commonFromReq(req);
      const config = ConfigService.getInstance();
      const stored = await config.getAll().catch(() => []);
      const storedByKey = new Map(stored.map((s) => [s.key, s]));

      const rows: SettingRow[] = Object.entries(defaultConfig).map(
        ([key, defaultValue]) => {
          const dbEntry = storedByKey.get(key);
          return {
            key,
            current: dbEntry ? dbEntry.value : defaultValue,
            defaultValue,
            type: describeType(defaultValue),
            description: dbEntry?.description ?? "(no description on disk yet)",
            category: dbEntry?.category ?? deriveCategory(key),
          };
        },
      );
      for (const entry of stored) {
        if (!(entry.key in defaultConfig)) {
          rows.push({
            key: entry.key,
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

      res.type("text/html").send(renderSettingsPage({ ...common, groups }));
    }),
  );

  // ---------- Permissions ----------
  router.get(
    "/permissions",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const permissions = PermissionsService.getInstance(client);
      const all = await permissions.listAllPermissions(common.guildId);
      const commands = Array.from(client.commands.keys()).sort();
      const roleNames = await fetchRoleNames(client, common.guildId);

      const perCommand = new Map<string, string[]>();
      const allRoleIds = new Set<string>();
      for (const entry of all) {
        perCommand.set(entry.commandName, entry.roleIds);
        for (const r of entry.roleIds) allRoleIds.add(r);
      }
      const roleIds = Array.from(allRoleIds).sort((a, b) =>
        (roleNames.get(a) ?? a).localeCompare(roleNames.get(b) ?? b),
      );

      res.type("text/html").send(
        renderPermissionsPage({
          ...common,
          commands,
          roleIds,
          roleNames,
          perCommand,
        }),
      );
    }),
  );

  // ---------- Announcements ----------
  router.get(
    "/announcements",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const service = ScheduledAnnouncementService.getInstance(client);
      const config = ConfigService.getInstance();
      const [enabled, announcements, channelNames] = await Promise.all([
        config.getBoolean("announcements.enabled", false),
        service.listAnnouncements(common.guildId),
        fetchChannelNames(client, common.guildId),
      ]);

      const rows = announcements.map((a) => ({
        id: String(a._id),
        channelName: channelNames.get(a.channelId) ?? a.channelId,
        cron: a.cronSchedule,
        enabled: a.enabled,
        messagePreview:
          a.message.length > 80 ? `${a.message.slice(0, 80)}…` : a.message,
        embedTitle: a.embedData?.title ?? null,
        placeholders: a.placeholders,
        createdAt: new Date(a.createdAt).toISOString(),
      }));

      res
        .type("text/html")
        .send(renderAnnouncementsPage({ ...common, enabled, rows }));
    }),
  );

  // ---------- Polls ----------
  router.get(
    "/polls",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const service = PollService.getInstance(client);
      const config = ConfigService.getInstance();
      const [
        enabled,
        schedules,
        items,
        defaultDurationHours,
        cooldownDays,
        channelNames,
        roleNames,
      ] = await Promise.all([
        config.getBoolean("polls.enabled", false),
        service.listSchedules(common.guildId),
        service.listPollItems(common.guildId),
        config.getNumber("polls.default_duration_hours", 24),
        config.getNumber("polls.cooldown_days", 7),
        fetchChannelNames(client, common.guildId),
        fetchRoleNames(client, common.guildId),
      ]);

      res.type("text/html").send(
        renderPollsPage({
          ...common,
          enabled,
          defaultDurationHours,
          cooldownDays,
          schedules: schedules.map((s) => ({
            id: String(s._id),
            channelName: channelNames.get(s.channelId) ?? s.channelId,
            cron: s.cronSchedule,
            durationHours: s.pollDuration,
            pingRoleName: s.roleIdToPing
              ? (roleNames.get(s.roleIdToPing) ?? s.roleIdToPing)
              : null,
            enabled: s.enabled,
            lastRun: s.lastRun ? new Date(s.lastRun).toISOString() : "—",
          })),
          items: items.map((it) => ({
            question: it.question,
            answers: it.answers ?? [],
            tags: it.tags ?? [],
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
      const common = commonFromReq(req);
      const config = ConfigService.getInstance();
      const service = ReactionRoleService.getInstance(client);
      const [enabled, configChannelId, all, archived, channelNames] =
        await Promise.all([
          config.getBoolean("reactionroles.enabled", false),
          config.getString("reactionroles.message_channel_id", ""),
          service.listReactionRoles(common.guildId),
          ReactionRoleConfig.find({ guildId: common.guildId, isArchived: true })
            .sort({ archivedAt: -1 })
            .limit(50)
            .lean(),
          fetchChannelNames(client, common.guildId),
        ]);

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
      }): ReturnType<typeof Object> => ({
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
        }),
      );
    }),
  );

  // ---------- Notices ----------
  router.get(
    "/notices",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const config = ConfigService.getInstance();
      const [enabled, channelId, headerEnabled, notices, channelNames] =
        await Promise.all([
          config.getBoolean("notices.enabled", false),
          config.getString("notices.channel_id", ""),
          config.getBoolean("notices.header_enabled", true),
          Notice.find({}).sort({ category: 1, order: 1 }).lean(),
          fetchChannelNames(client, common.guildId),
        ]);

      const grouped = new Map<string, typeof notices>();
      for (const n of notices) {
        const arr = grouped.get(n.category) ?? [];
        arr.push(n);
        grouped.set(n.category, arr);
      }
      const groups = Array.from(grouped.entries()).map(([category, list]) => ({
        category,
        rows: list.map((n) => ({
          order: n.order,
          title: n.title,
          preview:
            n.content.length > 120 ? `${n.content.slice(0, 120)}…` : n.content,
          messageId: n.messageId ?? "",
          updatedAt: new Date(n.updatedAt).toISOString(),
        })),
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
        }),
      );
    }),
  );

  // ---------- Database ----------
  router.get(
    "/database",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const truncation = VoiceChannelTruncationService.getInstance(client);
      const config = ConfigService.getInstance();
      const status = truncation.getStatus();

      const [
        enabled,
        schedule,
        notificationChannelId,
        detailedDays,
        monthlyMonths,
        yearlyYears,
        channelNames,
      ] = await Promise.all([
        truncation.isEnabled(),
        truncation.getSchedule(),
        truncation.getNotificationChannel(),
        config.getNumber(
          "voicetracking.cleanup.retention.detailed_sessions_days",
          30,
        ),
        config.getNumber(
          "voicetracking.cleanup.retention.monthly_summaries_months",
          6,
        ),
        config.getNumber(
          "voicetracking.cleanup.retention.yearly_summaries_years",
          1,
        ),
        fetchChannelNames(client, common.guildId),
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
            notificationChannel: notificationChannelId
              ? {
                  name:
                    channelNames.get(notificationChannelId) ??
                    notificationChannelId,
                  id: notificationChannelId,
                }
              : null,
            detailedDays,
            monthlyMonths,
            yearlyYears,
          },
          collections,
        }),
      );
    }),
  );

  // ---------- Voice Channels ----------
  router.get(
    "/voice-channels",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const config = ConfigService.getInstance();
      const manager = VoiceChannelManager.getInstance(client);

      const [
        enabled,
        controlPanelEnabled,
        categoryName,
        lobbyName,
        offlineLobbyName,
        prefix,
      ] = await Promise.all([
        config.getBoolean("voicechannels.enabled", false),
        config.getBoolean("voicechannels.controlpanel.enabled", true),
        config.getString("voicechannels.category.name", "Voice Channels"),
        config.getString("voicechannels.lobby.name", "Lobby"),
        config.getString("voicechannels.lobby.offlinename", "Offline Lobby"),
        config.getString("voicechannels.channel.prefix", "🎮"),
      ]);

      let categoryFound = false;
      let totalManaged = 0;
      let totalEmpty = 0;
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
        const category = guild.channels.cache.find(
          (c: GuildBasedChannel) =>
            c.type === ChannelType.GuildCategory &&
            (c as CategoryChannel).name === categoryName,
        ) as CategoryChannel | undefined;

        if (category) {
          categoryFound = true;
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
        }),
      );
    }),
  );

  return router;
}
