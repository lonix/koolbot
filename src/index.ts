import express, { Request, Response } from "express";
import {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  Collection,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Routes,
  TextChannel,
  Partials,
  AuditLogEvent,
} from "discord.js";
import { env, getMissingRequiredEnv } from "./config/env.js";
import logger, { isDebugMode } from "./utils/logger.js";
import { sanitizeForLog } from "./utils/log-sanitize.js";
import { getSharedRest } from "./utils/discord-rest.js";
import { markMongoDisconnectIntentional } from "./utils/mongo.js";
import {
  replyWithError,
  replyWithUnexpectedError,
} from "./utils/error-reply.js";
import { runWithTimeout } from "./utils/run-with-timeout.js";
import { ConfigService } from "./services/config-service.js";
import { startComponentAudit } from "./utils/component-audit.js";
import { runNameToIdMigrations } from "./services/name-id-migrator.js";
import { runReactionRoleMigrations } from "./services/reaction-role-migrator.js";
import { CommandManager } from "./services/command-manager.js";
import {
  VoiceChannelManager,
  resolveManagedCategory,
} from "./services/voice-channel-manager.js";
import { VoiceChannelTracker } from "./services/voice-channel-tracker.js";
import { VoiceChannelAnnouncer } from "./services/voice-channel-announcer.js";
import { VoiceChannelTruncationService } from "./services/voice-channel-truncation.js";
import { MessageActivityTracker } from "./services/message-activity-tracker.js";
import { MessageActivityCleanupService } from "./services/message-activity-cleanup.js";
import { ReactionActivityTracker } from "./services/reaction-activity-tracker.js";
import { PollParticipationTracker } from "./services/poll-participation-tracker.js";
import { TrackingOptOutService } from "./services/tracking-opt-out-service.js";
import { CommandAuditCleanupService } from "./services/command-audit-cleanup.js";
import { WebAuditLogCleanupService } from "./services/web-audit-cleanup.js";
import { VersionCheckService } from "./services/version-check-service.js";
import { ModerationLogCleanupService } from "./services/moderation-log-cleanup.js";
import { NameHistoryCleanupService } from "./services/name-history-cleanup.js";
import { AdoptionSnapshotCleanupService } from "./services/adoption-snapshot-cleanup.js";
import { RoleGroupSyncService } from "./services/role-group-sync-service.js";
import { NameHistoryService } from "./services/name-history-service.js";
import { ScheduledAnnouncementService } from "./services/scheduled-announcement-service.js";
import { ChannelInitializer } from "./services/channel-initializer.js";
import { StartupMigrator } from "./services/startup-migrator.js";
import { DiscordLogger } from "./services/discord-logger.js";
import { BotStatusService } from "./services/bot-status-service.js";
import { QuoteChannelManager } from "./services/quote-channel-manager.js";
import { NoticesChannelManager } from "./services/notices-channel-manager.js";
import { ReactionRoleService } from "./services/reaction-role-service.js";
import { PollService } from "./services/poll-service.js";
import { LeaderboardRoleService } from "./services/leaderboard-role-service.js";
import { DigestService } from "./services/digest-service.js";
import { RewindNudgeService } from "./services/rewind-nudge-service.js";
import { BirthdayService } from "./services/birthday-service.js";
import { WelcomeService } from "./services/welcome-service.js";
import {
  handleDepartureAuditEntry,
  revokeWebSessionsForDeparture,
  warnIfLeaveEventsMissing,
} from "./services/member-departure-sessions.js";
import {
  RulesService,
  RULES_ACCEPT_CUSTOM_ID,
} from "./services/rules-service.js";
import { EventService } from "./services/event-service.js";
import { handleGroupSelfJoin } from "./services/event-group-assignment.js";
import { installLeaderCleanup } from "./services/event-group-leaders.js";
import { installLeadsChannelSync } from "./services/event-leads-sync.js";
import {
  EventNicknameTags,
  installEventNicknameTags,
} from "./services/event-nickname-tags.js";
import { LfgService } from "./services/lfg-service.js";
import { ReminderService } from "./services/reminder-service.js";
import { ModerationService } from "./services/moderation-service.js";
import { RaidProtectionService } from "./services/raid-protection-service.js";
import { ModerationCaseReviewService } from "./services/moderation-case-review-service.js";
import { WizardService } from "./services/wizard-service.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "./utils/guild-members-intent.js";
import { DEFAULT_ALLOWED_MENTIONS } from "./utils/allowed-mentions.js";
import { applyGuildScope, shouldIgnoreGuild } from "./utils/guild-scope.js";
import { MonitoringService } from "./services/monitoring-service.js";
import {
  createUserWebRouter,
  createWebRouter,
  isWebUIEnabled,
  validateWebUIEnvVars,
} from "./web/index.js";
import {
  createMetricsRouter,
  recordDiscordEvent,
  setBotUp,
  setVoiceSessionsProvider,
} from "./web/metrics.js";
import mongoose from "mongoose";

// Validate critical environment variables
const missingVars = getMissingRequiredEnv();

if (missingVars.length > 0) {
  logger.error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
  process.exit(1);
}

// Set debug mode
if (isDebugMode()) {
  logger.info("Debug mode enabled");
}

// Register global error handlers EARLY to catch initialization errors.
//
// Unhandled rejections log and the bot keeps running (issue #837). discord.js
// does not await event-listener promises, so a single rejected REST call — an
// expired interaction token, a transient 5xx — lands here; killing the whole
// bot over one dropped reply is far worse than losing that reply. Genuinely
// fatal states still exit through their own error paths, and
// `uncaughtException` below remains fatal.
process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  process.exit(1);
});

// Extend Client type to include commands collection
declare module "discord.js" {
  export interface Client {
    commands: Collection<
      string,
      {
        execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
        autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
      }
    >;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    // Required to receive guildAuditLogEntryCreate events for the moderation
    // log (#728) — mirrors native kick/ban/timeout actions into the log.
    GatewayIntentBits.GuildModeration,
    // Required to receive messagePollVoteAdd events for poll-participation
    // tracking (#570). The events still only fire for guild polls.
    GatewayIntentBits.GuildMessagePolls,
    // Privileged: only requested when the operator opts in (#1038), because
    // asking for an intent the developer portal has not enabled makes login
    // fail. Feeds guildMemberUpdate for server-nickname history.
    ...(env.guildMembersIntent ? [GatewayIntentBits.GuildMembers] : []),
  ],
  // Partials.User is required for messageReactionAdd/Remove to fire for
  // uncached users (#809). Without it, discord.js drops the event before any
  // listener runs — so a member reacting to an old reaction-role message the
  // bot hasn't cached (common right after a restart) silently gets no role.
  // Partials.Message/Reaction only cover uncached messages/reactions, not
  // uncached users. Both consumers (ReactionRoleService, ReactionActivityTracker)
  // already resolve partial users via user.fetch().
  partials: [Partials.Message, Partials.Reaction, Partials.User],
  // Safe default for every send that does not set its own allowedMentions
  // (#1146): no @everyone / @here / role pings from text the bot echoes, such
  // as member display names. Intentional role or everyone pings set their own.
  allowedMentions: DEFAULT_ALLOWED_MENTIONS,
});

// Add commands collection to client
client.commands = new Collection();

let isShuttingDown = false;
// Flipped to true once initializeServices() completes (#521). Until then the
// readiness endpoints (/ready, /health) report 503 instead of refusing the
// connection, which surfaces a slow startup as an observable HTTP response.
let isReady = false;
let discordLogger: DiscordLogger;
const botStatusService: BotStatusService = BotStatusService.getInstance(client);

// HTTP health server for Docker/Kubernetes. The server starts listening
// immediately at process startup — before client.login() — so the port is
// always open (#521), and exposes separate liveness and readiness probes:
//
//   /live   liveness  — 200 as soon as the process is up and the event loop
//                       is responsive. Point a Kubernetes livenessProbe here
//                       so a slow Discord/MongoDB startup never triggers a
//                       restart.
//   /ready  readiness — 200 only once initialization has finished and Discord
//                       and MongoDB are connected; 503 otherwise. Point a
//                       readinessProbe / load-balancer check here.
//   /health           — backward-compatible alias of /ready (Docker
//                       HEALTHCHECK and existing setups). Same semantics.

// Readiness gate shared by /ready and /health. Returns true only once
// initialization has completed and both Discord and MongoDB are connected.
function isAppReady(): boolean {
  if (!isReady) {
    return false;
  }
  let discordReady: boolean;
  let mongoReady: boolean;
  try {
    discordReady =
      typeof client.isReady === "function" ? client.isReady() : false;
  } catch {
    discordReady = false;
  }
  try {
    mongoReady = mongoose.connection.readyState === 1;
  } catch {
    mongoReady = false;
  }
  return discordReady && mongoReady;
}

function startHealthServer(): void {
  const healthApp = express();
  // Do not advertise the framework on any response (#1149).
  healthApp.disable("x-powered-by");

  // Liveness: the process is running. Always 200 once the server is listening.
  healthApp.get("/live", (_req: Request, res: Response) => {
    res.status(200).send("OK");
  });

  // Readiness: ready to serve only when fully initialized and connected.
  const readinessHandler = (_req: Request, res: Response): void => {
    if (isAppReady()) {
      res.status(200).send("OK");
    } else {
      res.status(503).send(isReady ? "Service Unavailable" : "Starting");
    }
  };
  healthApp.get("/ready", readinessHandler);
  // /health is retained as a backward-compatible alias of /ready.
  healthApp.get("/health", readinessHandler);

  // Mount the WebUI behind the feature flag. When disabled, no /admin/*
  // route is registered, so the server responds 404 for those paths
  // exactly as it did before this scaffold landed.
  if (isWebUIEnabled()) {
    const errors = validateWebUIEnvVars();
    if (errors.length > 0) {
      logger.error(
        `WEBUI_ENABLED=true but its configuration is invalid: ${errors.join("; ")}. WebUI will not be mounted.`,
      );
    } else {
      // Default to NOT trusting any X-Forwarded-* headers so an attacker
      // cannot spoof req.ip and bypass the rate limiter. Operators behind
      // a reverse proxy can opt in by setting WEBUI_TRUST_PROXY to a hop
      // count (e.g. "1") or to one of express' supported strings ("loopback",
      // "linklocal", "uniquelocal", "true").
      const trustProxyRaw = (env.webui.trustProxy || "").trim();
      if (trustProxyRaw) {
        const asNumber = Number(trustProxyRaw);
        if (Number.isFinite(asNumber) && asNumber >= 0) {
          healthApp.set("trust proxy", asNumber);
        } else if (trustProxyRaw.toLowerCase() === "true") {
          healthApp.set("trust proxy", true);
          // `true` trusts every hop: any client can then forge
          // X-Forwarded-For and evade the per-IP rate limits (#1149).
          logger.warn(
            'WEBUI_TRUST_PROXY=true trusts every X-Forwarded-For hop, so clients can spoof their IP and bypass the Web UI rate limits. Set it to the number of proxies in front of KoolBot instead (e.g. "1").',
          );
        } else {
          healthApp.set("trust proxy", trustProxyRaw);
        }
        logger.info(`WebUI trust proxy set to: ${trustProxyRaw}`);
      }
      healthApp.use("/admin", createWebRouter(client));
      healthApp.use("/me", createUserWebRouter(client));
      logger.info("WebUI mounted at /admin and user surface at /me");
    }
  } else {
    logger.debug("WEBUI_ENABLED is not true; /admin routes not mounted");
  }

  // Prometheus/OpenMetrics scrape endpoint (#509). Mounted only when
  // METRICS_ENABLED=true; otherwise nothing is registered and /metrics
  // stays 404. Optionally bearer-token protected via METRICS_TOKEN.
  const metricsRouter = createMetricsRouter();
  if (metricsRouter) {
    healthApp.use(metricsRouter);
  }

  healthApp.listen(3000, () => {
    logger.info("Healthcheck server running on port 3000");
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Ready! Logged in as ${readyClient.user.tag}`);

  // koolbot_up = 1: connected to Discord (#509).
  setBotUp(true);

  // Set connecting status (yellow) immediately when Discord is ready
  botStatusService.setConnectingStatus();

  await initializeServices();

  // Guild scoping (#1144): warn about, and optionally leave, guilds other than
  // GUILD_ID. Needs ConfigService, so it runs once services are wired up.
  await enforceGuildScope();
  ConfigService.getInstance().addChangeListener((key) => {
    if (key === LEAVE_OTHER_GUILDS_KEY) void enforceGuildScope();
  });

  // Flip the health flag so /health switches from 503 "Starting" to its
  // normal Discord + MongoDB readiness checks (#521). The server itself is
  // already listening — it was started before client.login() below.
  isReady = true;
});

// Events from a guild other than GUILD_ID are ignored (#1144), so one operator's
// bot can never merge another guild's activity into its own community. Leaving
// those guilds is an explicit opt-in that is off by default: an operator may
// deliberately keep the bot in a second guild.
const LEAVE_OTHER_GUILDS_KEY = "core.guild_scope.leave_other_guilds";

async function enforceGuildScope(): Promise<void> {
  try {
    const leave = await ConfigService.getInstance().getBoolean(
      LEAVE_OTHER_GUILDS_KEY,
      false,
    );
    await applyGuildScope(client.guilds.cache.values(), env.guildId, leave);
  } catch (error) {
    logger.error("Error applying guild scope:", error);
  }
}

// A guild the bot is added to after startup, and a flip of the opt-in setting
// from the Web UI (which only fires change listeners, not reload callbacks).
client.on(Events.GuildCreate, () => {
  void enforceGuildScope();
});

async function cleanupGlobalCommands(): Promise<void> {
  try {
    const token = env.discordToken;
    const clientId = env.clientId;

    if (!token || !clientId) {
      logger.warn(
        "Cannot check global commands: Missing DISCORD_TOKEN or CLIENT_ID",
      );
      return;
    }

    const rest = getSharedRest(token);

    // Check for global commands
    const globalCommands = (await rest.get(
      Routes.applicationCommands(clientId),
    )) as Array<{
      id: string;
      name: string;
      description: string;
    }>;

    if (globalCommands.length > 0) {
      logger.warn(
        `Found ${globalCommands.length} global commands that may conflict with guild commands:`,
      );
      globalCommands.forEach((cmd) => {
        logger.warn(`  - /${cmd.name} (${cmd.description})`);
      });

      // Remove global commands to prevent duplicates
      logger.info(
        "Removing global commands to prevent duplicate command issues...",
      );
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      logger.info("✅ Global commands removed successfully");
    } else {
      logger.debug("No global commands found - no cleanup needed");
    }
  } catch (error) {
    logger.error("Error checking/cleaning global commands:", error);
    // Don't fail startup for this - just log the error
  }
}

async function cleanupVoiceChannels(): Promise<void> {
  try {
    const configService = ConfigService.getInstance();

    // Check if voice channel management is enabled. Only the canonical
    // config-schema key is read here; legacy keys (voice_channel.enabled,
    // ENABLE_VC_MANAGEMENT) are no longer consulted. Deployments still on
    // legacy keys should run `npm run migrate-config` to populate the
    // canonical keys.
    const isEnabled = await configService.getBoolean(
      "voicechannels.enabled",
      false,
    );

    if (isEnabled) {
      logger.info("Cleaning up voice channels...");
      const guild = await client.guilds.fetch(
        await configService.getString("GUILD_ID", ""),
      );
      if (guild) {
        const category = await resolveManagedCategory(guild);

        if (category) {
          // Get lobby channel name from the canonical config-schema key.
          // Legacy keys (voice_channel.lobby_channel_name, LOBBY_CHANNEL_NAME)
          // are no longer consulted; run `npm run migrate-config` to populate
          // the canonical key. Guard against a present-but-blank value: an
          // empty name would make every channel compare unequal below and
          // delete the lobby itself.
          const lobbyChannelName =
            (await configService.getString(
              "voicechannels.lobby.name",
              "Lobby",
            )) || "Lobby";

          // Clean up any empty channels in the category
          for (const channel of category.children.cache.values()) {
            if (
              channel.type === ChannelType.GuildVoice &&
              channel.members.size === 0 &&
              channel.name !== lobbyChannelName
            ) {
              try {
                await channel.delete();
                logger.info(`Cleaned up empty channel ${channel.name}`);
              } catch (error) {
                logger.error(
                  `Error cleaning up channel ${channel.name}:`,
                  error,
                );
              }
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error("Error during voice channel cleanup:", error);
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.info("Shutdown already in progress, forcing exit...");
    process.exit(1);
  }

  isShuttingDown = true;
  const startTime = Date.now();

  // koolbot_up = 0: no longer serving (#509).
  setBotUp(false);

  try {
    logger.info(`🔄 Received ${signal}, starting graceful shutdown...`);

    // 1. Switch lobby to offline mode (priority 1) - 5 second timeout
    await runWithTimeout(
      async () => {
        // GUILD_ID is a bootstrap value read directly from the environment
        // (see env.ts) rather than through configService, so the guild lookup
        // still resolves if a signal arrives before ConfigService has been
        // wired up. Resolving the lobby itself does read ConfigService-managed
        // keys (`voicechannels.category_id` / `.lobby.*`);
        // renameLobbyToOffline() logs and skips if they don't resolve.
        const guildId = env.guildId ?? "";
        if (guildId) {
          const guild = await client.guilds.fetch(guildId);
          // Delegate to the manager: it resolves the lobby via
          // `voicechannels.lobby.name` inside the managed category, mirroring
          // renameLobbyToOnline() on startup. Matching on a hardcoded emoji
          // here never found the default "Lobby" and could rename an unrelated
          // channel that happened to contain it (#839).
          await voiceChannelManager.renameLobbyToOffline(guild);
        }
      },
      5000,
      "Lobby offline mode switch",
    );

    // 2. Set bot status to offline (priority 2) - 3 second timeout
    await runWithTimeout(
      async () => {
        await client.user?.setStatus("invisible");
      },
      3000,
      "Bot status offline",
    );

    // Slash commands are deliberately left registered. The next startup
    // re-syncs them anyway, and wiping them here only makes them vanish from
    // members' clients during a restart (#1294). Use
    // `npm run unregister-guild-commands` to really uninstall.

    // 4. Clean up voice channels (existing functionality) - 3 second timeout
    await runWithTimeout(
      async () => {
        await cleanupVoiceChannels();
      },
      3000,
      "Voice channel cleanup",
    );

    // 5. Stop quote channel cleanup job - 1 second timeout
    await runWithTimeout(
      async () => {
        await quoteChannelManager.stop();
      },
      1000,
      "Quote channel cleanup job stop",
    );

    // 6. Stop scheduled announcements cron jobs - 1 second timeout
    await runWithTimeout(
      async () => {
        scheduledAnnouncementService.destroy();
      },
      1000,
      "Scheduled announcements cleanup",
    );

    // 7. Stop remaining timer-owning services so their intervals/timeouts
    //    don't fire against a half-closed Discord client or MongoDB
    //    connection during the rest of the shutdown sequence.
    await runWithTimeout(
      async () => {
        voiceChannelManager.destroy();
        voiceChannelAnnouncer.destroy();
        voiceChannelTruncation.destroy();
        messageActivityCleanup.destroy();
        CommandAuditCleanupService.getInstance().destroy();
        WebAuditLogCleanupService.getInstance().destroy();
        VersionCheckService.getInstance().destroy();
        RaidProtectionService.getInstance(client).destroy();
        ModerationLogCleanupService.getInstance().destroy();
        moderationCaseReviewService.destroy();
        nameHistoryCleanup?.destroy();
        adoptionSnapshotCleanup?.destroy();
        RoleGroupSyncService.getInstance(client).destroy();
        await noticesChannelManager.stop();
        pollService.destroy();
        pollParticipationTracker.destroy();
        leaderboardRoleService.destroy();
        digestService.destroy();
        rewindNudgeService.destroy();
        birthdayService.destroy();
        eventService.destroy();
        EventNicknameTags.getInstance(client).destroy();
        lfgService.destroy();
        reminderService.destroy();
        WizardService.getInstance().shutdown();
        // Persist any metrics still buffered in memory before the DB
        // connection closes below, then stop the flush/logging timers.
        await MonitoringService.getInstance().flushMetrics();
        MonitoringService.getInstance().destroy();
        await botStatusService.shutdown();
      },
      2000,
      "Service timer cleanup",
    );

    // 8. Close database connections - 3 second timeout
    await runWithTimeout(
      async () => {
        const { default: mongoose } = await import("mongoose");
        if (mongoose.connection.readyState !== 0) {
          // Expected disconnect: keep the trackers from warning "connection lost".
          markMongoDisconnectIntentional();
          await mongoose.connection.close();
          logger.info("✅ Database connections closed");
        }
      },
      3000,
      "Database connection closure",
    );

    // 9. Destroy Discord client - 5 second timeout
    await runWithTimeout(
      async () => {
        await client.destroy();
      },
      5000,
      "Discord client destruction",
    );

    const shutdownTime = Date.now() - startTime;
    logger.info(`✅ Graceful shutdown completed in ${shutdownTime}ms`);

    // Exit with success
    process.exit(0);
  } catch (error) {
    logger.error("❌ Error during graceful shutdown:", error);
    process.exit(1);
  }
}

// Service instances (declared outside try-catch for proper scoping)
let configService: ConfigService;
let commandManager: CommandManager;
let voiceChannelManager: VoiceChannelManager;
let voiceChannelTracker: VoiceChannelTracker;
let voiceChannelAnnouncer: VoiceChannelAnnouncer;
let voiceChannelTruncation: VoiceChannelTruncationService;
let messageActivityTracker: MessageActivityTracker;
let messageActivityCleanup: MessageActivityCleanupService;
let reactionActivityTracker: ReactionActivityTracker;
let pollParticipationTracker: PollParticipationTracker;
let scheduledAnnouncementService: ScheduledAnnouncementService;
let channelInitializer: ChannelInitializer;
let startupMigrator: StartupMigrator;
let quoteChannelManager: QuoteChannelManager;
let noticesChannelManager: NoticesChannelManager;
let reactionRoleService: ReactionRoleService;
let pollService: PollService;
let leaderboardRoleService: LeaderboardRoleService;
let nameHistoryCleanup: NameHistoryCleanupService;
let adoptionSnapshotCleanup: AdoptionSnapshotCleanupService;
let digestService: DigestService;
let rewindNudgeService: RewindNudgeService;
let birthdayService: BirthdayService;
let eventService: EventService;
let lfgService: LfgService;
let reminderService: ReminderService;
let moderationService: ModerationService;
let moderationCaseReviewService: ModerationCaseReviewService;

// Wrap service instantiation in try-catch to ensure errors are caught
try {
  configService = ConfigService.getInstance();
  commandManager = CommandManager.getInstance(client);
  voiceChannelManager = VoiceChannelManager.getInstance(client);
  // Feed the koolbot_voice_sessions_active gauge (#509) at scrape time.
  setVoiceSessionsProvider(() => voiceChannelManager.getActiveSessionCount());
  voiceChannelTracker = VoiceChannelTracker.getInstance(client);
  voiceChannelAnnouncer = VoiceChannelAnnouncer.getInstance(client);
  voiceChannelTruncation = VoiceChannelTruncationService.getInstance(client);
  messageActivityTracker = MessageActivityTracker.getInstance(client);
  messageActivityCleanup = MessageActivityCleanupService.getInstance(client);
  reactionActivityTracker = ReactionActivityTracker.getInstance(client);
  pollParticipationTracker = PollParticipationTracker.getInstance(client);
  scheduledAnnouncementService =
    ScheduledAnnouncementService.getInstance(client);
  channelInitializer = ChannelInitializer.getInstance(client);
  startupMigrator = StartupMigrator.getInstance();
  quoteChannelManager = QuoteChannelManager.getInstance(client);
  noticesChannelManager = NoticesChannelManager.getInstance(client);
  reactionRoleService = ReactionRoleService.getInstance(client);
  pollService = PollService.getInstance(client);
  leaderboardRoleService = LeaderboardRoleService.getInstance(client);
  digestService = DigestService.getInstance(client);
  rewindNudgeService = RewindNudgeService.getInstance(client);
  birthdayService = BirthdayService.getInstance(client);
  eventService = EventService.getInstance(client);
  // Group leaders (#1195): unassigning a member clears their leader role, for
  // every source of assignment changes (Web UI, self-join, member data reset).
  installLeaderCleanup();
  // Leads-only channel (#1199): a leader change updates who may join it, for
  // every source of a change (host panel, unassign cleanup, member data reset).
  const events = eventService;
  installLeadsChannelSync(
    (guildId, eventId, takeRevoked) =>
      events.syncLeadsAccess(guildId, eventId, takeRevoked),
    (change) => events.trackLeaderChange(change),
  );
  // Temporary clan tags (#1194): tag on assignment, restore on unassign and,
  // through the end-of-event hook, when an event ends. Cancel, the periodic
  // sweep and the startup reconcile (below) cover the rest.
  installEventNicknameTags(client);
  lfgService = LfgService.getInstance(client);
  reminderService = ReminderService.getInstance(client);
  moderationService = ModerationService.getInstance(client);
  moderationCaseReviewService = ModerationCaseReviewService.getInstance(client);
} catch (error) {
  logger.error("❌ Fatal error during service instantiation:", error);
  process.exit(1);
}

// Handle process termination. Registered AFTER service instantiation so the
// singletons gracefulShutdown() relies on (e.g. configService, the timer-owning
// services) are guaranteed to exist by the time a SIGINT/SIGTERM can invoke it.
// Service instantiation above is synchronous, so this does not widen any
// meaningful window during which signals would go unhandled.
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Bot status service is already initialized above

async function initializeServices(): Promise<void> {
  try {
    // Set client for services that need it
    configService.setClient(client);

    // Check and clean up any global commands that might cause duplicates
    await cleanupGlobalCommands();

    // Initialize services
    await configService.initialize();
    // await configService.migrateFromEnv(); // Disabled - let startup migrator handle all migration
    await startupMigrator.checkForOutdatedSettings();

    // Anti-raid (#1045), as early as config is readable so joins that arrive
    // during the rest of startup are evaluated against the restored state
    // (they also wait, bounded, for this). Restore a lockdown that was on
    // before the restart and warn when the feature is on but a prerequisite
    // (moderation log, Server Members Intent) is missing. Detection is
    // event-driven; the only timers are the per-guild lockdown auto-expiry
    // timers, cleared by `destroy()` on shutdown.
    const raidProtection = RaidProtectionService.getInstance(client);
    await raidProtection.initialize();
    await raidProtection.warnIfInactive();

    // Initialize Discord logger AFTER database connection is established
    discordLogger = DiscordLogger.getInstance(client);
    await discordLogger.initialize();

    // Log database connection status
    await discordLogger.logDatabaseStatus(true);

    // Try to register commands, but don't fail if Discord API is unavailable
    try {
      await commandManager.registerCommands();
      await commandManager.populateClientCommands();
      logger.info("✅ Discord commands registered successfully");

      // Log successful Discord registration
      await discordLogger.logDiscordRegistrationSuccess();
    } catch (error) {
      logger.warn(
        "⚠️ Failed to register Discord commands - bot will continue without slash commands",
      );
      logger.warn(
        "💡 Voice channel management and user tracking will still work",
      );
      logger.warn(
        "💡 Restart the bot when Discord API is available to register commands",
      );
      logger.debug("Command registration error details:", error);
    }

    // Get guild ID from config
    const guildId = await configService.getString("GUILD_ID", "");
    if (!guildId) {
      throw new Error("GUILD_ID not configured");
    }

    // Translate any legacy name-stored Discord references (e.g. role names
    // or channel names) into IDs before services that consume them start
    // up. One-shot, idempotent, no-op on already-migrated deployments.
    await runNameToIdMigrations(client, guildId, configService);

    // Backfill the autoCreated flag on legacy reaction-role mappings so their
    // delete semantics survive the #813 schema change. Idempotent no-op once
    // every row carries the field.
    await runReactionRoleMigrations();

    // Load the member tracking opt-outs before any tracker can write (#918).
    // A failed load must not stop startup: the service fails closed (no
    // tracking at all) and retries in the background until it succeeds.
    try {
      await TrackingOptOutService.getInstance().initialize();
    } catch (error) {
      logger.error(
        "Failed to load tracking opt-outs; tracking is paused until they load",
        error,
      );
    }

    // Initialize voice channel services
    await voiceChannelManager.initialize(guildId);
    await voiceChannelTracker.initialize();
    await voiceChannelTruncation.initialize();
    await messageActivityTracker.initialize();
    await messageActivityCleanup.initialize();
    await reactionActivityTracker.initialize();
    await pollParticipationTracker.initialize();
    await voiceChannelAnnouncer.start();
    await scheduledAnnouncementService.start();
    await channelInitializer.initializeChannels(
      await client.guilds.fetch(guildId),
    );

    // Initialize quote channel manager
    await quoteChannelManager.initialize();

    // Initialize notices channel manager
    await noticesChannelManager.initialize();

    // Initialize reaction role service
    await reactionRoleService.initialize();

    // Initialize poll service
    await pollService.start();

    // Initialize leaderboard role rewards service
    await leaderboardRoleService.start();

    // Initialize weekly voice-activity digest service (#483)
    await digestService.start();

    // Initialize annual rewind nudge service (#484). The /me/rewind
    // page itself is served by the user WebUI router regardless of
    // this service — this only schedules the end-of-year DM nudge.
    await rewindNudgeService.start();

    // Initialize birthday celebrations service (#657). Members set their
    // date on /me/birthday; this schedules the recurring "is it anyone's
    // birthday today (in their timezone)?" check.
    await birthdayService.start();
    await eventService.start();
    // Restore any nickname a crash left tagged (#1194). Runs even with events
    // off (restoring is never gated); not awaited, it paces its Discord calls.
    void EventNicknameTags.getInstance(client)
      .reconcileOnStartup()
      .catch((error: unknown) =>
        logger.error("Event nickname tag reconcile failed:", error),
      );

    // Start the ad-hoc LFG sweep (#957). Members open posts with /lfg; this
    // closes the ones that filled nobody's party before their timer ran out.
    await lfgService.start();

    // Start the personal reminder scan (#866). Members schedule their own
    // reminders with /remind; this delivers the due ones once a minute.
    await reminderService.start();

    // Initialize the moderation log (#728). No timers to own — this just logs
    // its enabled state; the /warn write path and the audit-log mirroring
    // below both gate on `moderation.enabled` at call time.
    await moderationService.initialize();

    // Start the slash-command audit log cleanup cron (#459)
    CommandAuditCleanupService.getInstance().start();

    // Start the WebUI audit log retention cleanup cron (#756). Gates on
    // `core.web_audit.retention_days` at run time (0 = keep forever).
    WebAuditLogCleanupService.getInstance().start();

    // Start the moderation-log retention cleanup cron (#742). Gates on
    // `moderation.enabled` and `moderation.retention_days` at run time.
    ModerationLogCleanupService.getInstance().start();

    // Start the due-review job for moderation cases (#908). Gates on
    // `moderation.enabled` and `moderation.cases.enabled`.
    await moderationCaseReviewService.start();

    // Name history (#1038): retention cleanup cron, plus a clear startup
    // warning when nicknames cannot be recorded for lack of the intent.
    nameHistoryCleanup = NameHistoryCleanupService.getInstance(client);
    await nameHistoryCleanup.start();

    // Server-adoption snapshot retention cleanup (#1018). Gates on
    // `adoption.snapshot.retention_days` at run time (0 = keep forever).
    adoptionSnapshotCleanup =
      AdoptionSnapshotCleanupService.getInstance(client);
    await adoptionSnapshotCleanup.start();

    // Role group sync (#1021): periodic reconcile against Discord. Role
    // edit/delete events (below) feed the same service. Gates on
    // `adoption.role_groups.reconcile_enabled`.
    const roleGroupSync = RoleGroupSyncService.getInstance(client);
    await roleGroupSync.start();
    void roleGroupSync.runNow().catch((error: unknown) => {
      logger.error("Initial role group reconcile failed:", error);
    });
    if (
      await ConfigService.getInstance()
        .getBoolean("namehistory.enabled", false)
        .catch(() => false)
    ) {
      if (!env.guildMembersIntent) {
        logger.warn(
          `namehistory.enabled is on but the bot is not requesting the Server Members Intent: server nickname changes are not recorded (usernames and display names still are). ${GUILD_MEMBERS_INTENT_HOWTO}`,
        );
      }
    }

    // Welcome messages (#767): warn when the feature is on but the
    // GuildMembers intent is off, since join events then never arrive.
    await WelcomeService.getInstance().warnIfIntentMissing();

    // Web UI sessions end when a member leaves (#1151): warn once when the
    // leave event cannot arrive. The live membership re-check still covers it.
    warnIfLeaveEventsMissing(isWebUIEnabled());

    // Start the update check (#1029). An anonymous GET of the latest public
    // release, at startup and every 12h; gates on `core.updatecheck.enabled`
    // at run time and never blocks startup on the network round-trip.
    await VersionCheckService.getInstance(client).start();

    // Switch lobby to online mode on startup and handle any users in offline lobby
    try {
      const guild = await client.guilds.fetch(guildId);
      const lobbyOnline = await voiceChannelManager.renameLobbyToOnline(guild);
      if (!lobbyOnline) {
        logger.error(
          "❌ Lobby could not be switched to online mode — the voice channel category or the " +
            "bot's Manage Channels permission is misconfigured. Periodic voice channel cleanup " +
            "stays paused until this is fixed (#843).",
        );
      }
    } catch (error) {
      logger.error("❌ Error switching lobby to online mode:", error);
    }

    // Prime the VC user count from the live channel cache so the presence
    // reflects users already sitting in voice at startup, instead of showing
    // the "lonely" status until the next voiceStateUpdate (#614). Registering
    // the provider also lets the status monitor self-heal the count later.
    botStatusService.setVcUserCountProvider(() =>
      voiceChannelManager.getTotalVcUserCount(),
    );
    await botStatusService.refreshVcUserCount();

    // Set bot to fully operational status (green) and start VC monitoring
    botStatusService.setOperationalStatus();
    botStatusService.startVcMonitoring();

    logger.info("All services initialized successfully");
  } catch (error) {
    logger.error("Error initializing services:", error);

    // Log startup failure
    if (discordLogger) {
      await discordLogger.logError(
        error instanceof Error ? error : new Error(String(error)),
        "service initialisation",
      );
    }

    process.exit(1);
  }
}

// Track Discord connectivity for koolbot_up (#509). ClientReady flips it
// to 1; a shard dropping flips it to 0, and a resume brings it back.
client.on(Events.ShardDisconnect, () => {
  recordDiscordEvent("shardDisconnect");
  setBotUp(false);
});
client.on(Events.ShardResume, () => {
  recordDiscordEvent("shardResume");
  setBotUp(true);
});

client.on(Events.InteractionCreate, async (interaction) => {
  recordDiscordEvent("interactionCreate");
  // Guild scoping (#1144). Commands are only registered for GUILD_ID, but
  // buttons and menus on messages the bot left behind could still arrive.
  if (shouldIgnoreGuild(interaction.guildId, env.guildId)) {
    if (interaction.isRepliable() && !interaction.isAutocomplete()) {
      await replyWithError(interaction, {
        title: "This bot isn't set up for this server",
        next: "Use it in the server it was set up for, or ask an admin.",
      });
    }
    return;
  }
  // Handle autocomplete interactions
  if (interaction.isAutocomplete()) {
    try {
      const command = client.commands.get(interaction.commandName);
      if (!command || !command.autocomplete) {
        return;
      }
      await command.autocomplete(interaction);
    } catch (error) {
      logger.error(
        `Error handling autocomplete for ${interaction.commandName}:`,
        error,
      );
    }
    return;
  }

  // Buttons, select menus and modals skip `executeCommand`, so apply the same
  // opt-in rate limit here (#1147).
  if (
    (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
    (await commandManager.refuseIfComponentRateLimited(interaction))
  ) {
    return;
  }

  // Handle button interactions
  if (interaction.isButton()) {
    const audit = startComponentAudit(interaction, "button");
    try {
      if (interaction.customId.startsWith("vc_control_")) {
        const { handleVCControlButton } =
          await import("./handlers/vc-control-button-handler.js");
        await handleVCControlButton(interaction);
      } else if (interaction.customId.startsWith("vc_preset_")) {
        const { handleVCPresetButton } =
          await import("./handlers/vc-preset-handler.js");
        await handleVCPresetButton(interaction);
      } else if (interaction.customId.startsWith("event_rsvp_")) {
        const { handleEventRsvpButton } =
          await import("./handlers/event-rsvp-handler.js");
        await handleEventRsvpButton(interaction);
      } else if (interaction.customId.startsWith("evcust:")) {
        const { handleCustomiseButton } =
          await import("./handlers/event-customise-handler.js");
        await handleCustomiseButton(interaction);
      } else if (interaction.customId.startsWith("lfg_")) {
        const { handleLfgButton } =
          await import("./handlers/lfg-button-handler.js");
        await handleLfgButton(interaction);
      } else if (interaction.customId === RULES_ACCEPT_CUSTOM_ID) {
        await RulesService.getInstance(client).handleAcceptButton(interaction);
      } else if (interaction.customId.startsWith("reactrole:btn:")) {
        await reactionRoleService.handleButtonInteraction(interaction);
      } else {
        audit.unrecognised();
        logger.debug(
          `Ignoring button interaction with unrecognized customId: ${sanitizeForLog(interaction.customId)}`,
        );
        await replyWithError(interaction, {
          title: "This button is out of date",
          next: "Use the newest controls in your channel, or run the command again.",
        });
      }
      await audit.done();
    } catch (error) {
      logger.error("Error handling button interaction:", error);
      await audit.failed(error);
    }
    return;
  }

  // Handle select menu interactions
  if (interaction.isStringSelectMenu()) {
    const audit = startComponentAudit(interaction, "select");
    try {
      if (interaction.customId.startsWith("vc_transfer_select_")) {
        const { handleVCTransferSelect } =
          await import("./handlers/vc-transfer-select-handler.js");
        await handleVCTransferSelect(interaction);
      } else if (interaction.customId.startsWith("vc_preset_")) {
        const { handleVCPresetSelect } =
          await import("./handlers/vc-preset-handler.js");
        await handleVCPresetSelect(interaction);
      } else if (interaction.customId === "reactrole:sel") {
        await reactionRoleService.handleSelectInteraction(interaction);
      } else {
        audit.unrecognised();
        logger.debug(
          `Ignoring select menu interaction with unrecognized customId: ${sanitizeForLog(interaction.customId)}`,
        );
        await replyWithError(interaction, {
          title: "This menu is out of date",
          next: "Use the newest controls in your channel, or run the command again.",
        });
      }
      await audit.done();
    } catch (error) {
      logger.error("Error handling select menu interaction:", error);
      await audit.failed(error);
    }
    return;
  }

  // Handle modal submit interactions
  if (interaction.isModalSubmit()) {
    const audit = startComponentAudit(interaction, "modal");
    try {
      if (interaction.customId.startsWith("vc_modal_")) {
        const { handleVCModal } =
          await import("./handlers/vc-modal-handler.js");
        await handleVCModal(interaction);
      } else if (interaction.customId.startsWith("evcust:")) {
        const { handleCustomiseModal } =
          await import("./handlers/event-customise-handler.js");
        await handleCustomiseModal(interaction);
      } else {
        audit.unrecognised();
        logger.debug(
          `Ignoring modal interaction with unrecognized customId: ${sanitizeForLog(interaction.customId)}`,
        );
        await replyWithError(interaction, {
          title: "This form is out of date",
          next: "Use the newest controls in your channel, or run the command again.",
        });
      }
      await audit.done();
    } catch (error) {
      logger.error("Error handling modal interaction:", error);
      await audit.failed(error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const command = client.commands.get(interaction.commandName);
    if (!command) {
      logger.error(`No command matching ${interaction.commandName} was found.`);
      // Attempt a one-time refresh in case commands were not yet populated
      try {
        await commandManager.populateClientCommands();
        const refreshed = client.commands.get(interaction.commandName);
        if (!refreshed) {
          return;
        }
        await commandManager.executeCommand(
          interaction.commandName,
          interaction as ChatInputCommandInteraction,
          () => refreshed.execute(interaction as ChatInputCommandInteraction),
        );
        return;
      } catch (refreshError) {
        logger.error(
          "Error refreshing commands after missing command:",
          refreshError,
        );
        return;
      }
    }

    await commandManager.executeCommand(
      interaction.commandName,
      interaction as ChatInputCommandInteraction,
      () => command.execute(interaction as ChatInputCommandInteraction),
    );
  } catch (error) {
    logger.error(`Error executing command ${interaction.commandName}:`, error);
    await replyWithUnexpectedError(interaction);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  recordDiscordEvent("voiceStateUpdate");
  if (shouldIgnoreGuild(newState.guild.id, env.guildId)) return;
  try {
    const member = newState.member || oldState.member;
    if (member) {
      logger.debug(
        `Voice state update: ${sanitizeForLog(member.displayName)} (${member.id}) - Old: ${sanitizeForLog(oldState.channel?.name) || "none"} -> New: ${sanitizeForLog(newState.channel?.name) || "none"}`,
      );
    }

    // Before the first await (#918): the tracker checks this ticket, so an
    // opt-out or reset landing while the channel manager runs still wins.
    const trackingAdmission = TrackingOptOutService.getInstance().admission();

    // Event group self-join (#1191): joining a team group's channel records
    // the member in that group. Started here, not awaited, and with its own
    // error handling, so it neither waits for nor depends on the channel
    // manager and tracker below. Its own cheap lookup finds nothing for any
    // channel that is not an open event's group channel.
    if (
      member &&
      !member.user.bot &&
      newState.channelId &&
      newState.channelId !== oldState.channelId
    ) {
      handleGroupSelfJoin({
        guildId: newState.guild.id,
        userId: member.id,
        channelId: newState.channelId,
        admission: trackingAdmission,
      }).catch((error: unknown) => {
        logger.error("Error recording event group self-join:", error);
      });
    }

    await voiceChannelManager.handleVoiceStateUpdate(oldState, newState);
    await voiceChannelTracker.handleVoiceStateUpdate(
      oldState,
      newState,
      trackingAdmission,
    );

    // Name history (#1038): snapshot the member on a voice join.
    if (newState.member && newState.channelId && !oldState.channelId) {
      await NameHistoryService.getInstance().recordMember(
        newState.member,
        trackingAdmission,
      );
    }

    // Update bot status with current VC user count (username logic removed)
    if (botStatusService) {
      const vcUserCount = await voiceChannelManager.getTotalVcUserCount();
      botStatusService.updateVcUserCount(vcUserCount);
    }
  } catch (error) {
    logger.error("Error handling voice state update:", error);
  }
});

// Handle text messages for per-user/per-channel activity tracking (#495).
// Gating (enabled, bot/DM, excluded channels) lives in the tracker.
client.on(Events.MessageCreate, async (message) => {
  recordDiscordEvent("messageCreate");
  if (shouldIgnoreGuild(message.guildId, env.guildId)) return;
  try {
    // Before the first await (#918): see the voice handler.
    const nameAdmission = TrackingOptOutService.getInstance().admission();
    await messageActivityTracker.handleMessageCreate(message);
    // Name history (#1038): a message is a free chance to snapshot the
    // author's names; the service throttles unchanged members to no I/O.
    if (message.member && !message.author.bot) {
      await NameHistoryService.getInstance().recordMember(
        message.member,
        nameAdmission,
      );
    }
  } catch (error) {
    logger.error("Error handling messageCreate:", error);
  }
});

// Handle reactions, fanning out to the activity tracker (#570) and the
// reaction-role service (#810) — mirroring how voice presence fans out to two
// services. Partial resolution and the bot guard happen once here; per-feature
// gating (enabled, DM, excluded channels) lives in each service.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  recordDiscordEvent("messageReactionAdd");
  // Before any partial fetch: a foreign guild's reaction costs no REST call.
  if (shouldIgnoreGuild(reaction.message.guildId, env.guildId)) return;
  const nameAdmission = TrackingOptOutService.getInstance().admission();
  try {
    // Bots are always ignored; `bot` is populated even on partial users, so
    // guard first to avoid unnecessary fetches for bot reactions.
    if (user.bot) {
      return;
    }
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }
    if (user.partial) {
      user = await user.fetch();
    }
    await reactionActivityTracker.handleReactionAdd(reaction, user);
    if (reaction.message.guildId) {
      await NameHistoryService.getInstance().recordUser(
        reaction.message.guildId,
        user,
        undefined,
        nameAdmission,
      );
    }
    await reactionRoleService.handleReactionAdd(reaction, user);
  } catch (error) {
    logger.error("Error handling messageReactionAdd:", error);
  }
});

// Handle reaction removals for the reaction-role service (#810). Partial
// resolution and the bot guard happen once here; enablement gating lives in
// the service.
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  recordDiscordEvent("messageReactionRemove");
  if (shouldIgnoreGuild(reaction.message.guildId, env.guildId)) return;
  try {
    // Bots are always ignored; `bot` is populated even on partial users, so
    // guard first to avoid unnecessary fetches for bot reactions.
    if (user.bot) {
      return;
    }
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }
    if (user.partial) {
      user = await user.fetch();
    }
    await reactionRoleService.handleReactionRemove(reaction, user);
  } catch (error) {
    logger.error("Error handling messageReactionRemove:", error);
  }
});

// Self-heal reaction-role configs when their backing Discord objects are
// deleted out from under the bot (#814). Each handler archives the affected
// config(s) so the DB stops drifting from reality; gating lives in the service.
client.on(Events.MessageDelete, async (message) => {
  recordDiscordEvent("messageDelete");
  if (shouldIgnoreGuild(message.guildId, env.guildId)) return;
  try {
    await reactionRoleService.handleMessageDelete(message);
  } catch (error) {
    logger.error("Error handling messageDelete:", error);
  }
});

client.on(Events.GuildRoleDelete, async (role) => {
  recordDiscordEvent("roleDelete");
  if (shouldIgnoreGuild(role.guild.id, env.guildId)) return;
  try {
    await reactionRoleService.handleRoleDelete(role);
  } catch (error) {
    logger.error("Error handling roleDelete:", error);
  }
  // Role group drift (#1021): its own try so one failing handler can't skip
  // the other. Only a role behind a group schedules a (debounced) reconcile.
  try {
    await RoleGroupSyncService.getInstance(client).handleRoleDelete(role);
  } catch (error) {
    logger.error("Error handling roleDelete for role group sync:", error);
  }
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  recordDiscordEvent("roleUpdate");
  if (shouldIgnoreGuild(newRole.guild.id, env.guildId)) return;
  try {
    await RoleGroupSyncService.getInstance(client).handleRoleUpdate(
      oldRole,
      newRole,
    );
  } catch (error) {
    logger.error("Error handling roleUpdate:", error);
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  recordDiscordEvent("channelDelete");
  if (
    shouldIgnoreGuild(
      "guildId" in channel ? channel.guildId : null,
      env.guildId,
    )
  )
    return;
  try {
    await reactionRoleService.handleChannelDelete(channel);
  } catch (error) {
    logger.error("Error handling channelDelete:", error);
  }
});

// Handle native-poll votes for per-user participation tracking (#570).
// Gating (enabled, DM/bot) lives in the tracker.
client.on(Events.MessagePollVoteAdd, async (pollAnswer, userId) => {
  recordDiscordEvent("messagePollVoteAdd");
  if (shouldIgnoreGuild(pollAnswer.poll.message.guildId, env.guildId)) return;
  try {
    await pollParticipationTracker.handlePollVoteAdd(pollAnswer, userId);
  } catch (error) {
    logger.error("Error handling messagePollVoteAdd:", error);
  }
});

// Mirror native moderation actions (kick/ban/unban/timeout) into the
// moderation log (#728). Gating (enabled, action type, target present) lives
// in the service. Requires the GuildModeration intent and the bot's View
// Audit Log permission.
client.on(Events.GuildAuditLogEntryCreate, async (auditLogEntry, guild) => {
  recordDiscordEvent("guildAuditLogEntryCreate");
  if (shouldIgnoreGuild(guild.id, env.guildId)) return;
  // A kick or ban ends the target's Web UI sessions (#1151), independent of
  // whether the moderation log is on. Never throws.
  await handleDepartureAuditEntry(auditLogEntry);
  try {
    await moderationService.handleAuditLogEntry(auditLogEntry, guild);
  } catch (error) {
    logger.error("Error handling guildAuditLogEntryCreate:", error);
  }
});

// A member who leaves, or is banned, loses their Web UI sessions at once
// (#1151). GuildMemberRemove needs the GuildMembers intent; GuildBanAdd and the
// audit-log kick/ban above do not. The live re-check (#1158) covers the rest.
client.on(Events.GuildMemberRemove, async (member) => {
  recordDiscordEvent("guildMemberRemove");
  if (shouldIgnoreGuild(member.guild.id, env.guildId)) return;
  await revokeWebSessionsForDeparture(member.id, "left");
});

client.on(Events.GuildBanAdd, async (ban) => {
  recordDiscordEvent("guildBanAdd");
  if (shouldIgnoreGuild(ban.guild.id, env.guildId)) return;
  await revokeWebSessionsForDeparture(ban.user.id, "ban");
});

// Handle channel updates to detect renames
client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  if (
    shouldIgnoreGuild(
      "guildId" in newChannel ? newChannel.guildId : null,
      env.guildId,
    )
  )
    return;
  try {
    // Only track voice channel updates
    if (newChannel.type !== ChannelType.GuildVoice) {
      return;
    }

    // Type guard - ensure we're working with guild-based channels
    if (!("name" in oldChannel) || !("name" in newChannel)) {
      return;
    }

    // Check if the channel name changed
    if (oldChannel.name !== newChannel.name) {
      logger.info(
        `Channel renamed: "${sanitizeForLog(oldChannel.name)}" → "${sanitizeForLog(newChannel.name)}" (${newChannel.id})`,
      );

      // Try to identify who renamed the channel by checking audit logs
      try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
          type: AuditLogEvent.ChannelUpdate,
          limit: 1,
        });

        const entry = auditLogs.entries.first();
        if (
          entry &&
          entry.targetId === newChannel.id &&
          Date.now() - entry.createdTimestamp < 5000
        ) {
          const executor = entry.executor;
          logger.info(
            `Channel renamed by: ${sanitizeForLog(executor?.displayName || executor?.username) || "Unknown"} (${executor?.id || "Unknown"})`,
          );
        }
      } catch (auditError) {
        logger.debug(
          "Could not fetch audit logs for channel rename:",
          auditError,
        );
      }
    }
  } catch (error) {
    logger.error("Error handling channel update:", error);
  }
});

// Name history (#1038). `userUpdate` needs no privileged intent but only fires
// for cached users; it carries no guild, so it is attributed to the bot's
// configured guild (the bot is single-guild via GUILD_ID), and only for users
// who are members of it (#1144).
client.on(Events.UserUpdate, async (_oldUser, newUser) => {
  recordDiscordEvent("userUpdate");
  if (!env.guildId) return;
  await NameHistoryService.getInstance().recordUserUpdate(
    client,
    env.guildId,
    newUser,
    (call, op) =>
      CommandManager.getInstance(client).makeDiscordApiCall(call, op, 5000, 1),
  );
});

// Nickname changes. Only delivered when the GuildMembers intent is on
// (GUILD_MEMBERS_INTENT=true); harmless to register either way.
client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
  recordDiscordEvent("guildMemberUpdate");
  if (shouldIgnoreGuild(newMember.guild.id, env.guildId)) return;
  await NameHistoryService.getInstance().recordMember(
    newMember,
    TrackingOptOutService.getInstance().admission(),
  );
});

// New-member welcome message (#767). Only delivered when the GuildMembers
// intent is on (GUILD_MEMBERS_INTENT=true); the service gates on
// welcome.enabled per event and never throws.
client.on(Events.GuildMemberAdd, async (member) => {
  recordDiscordEvent("guildMemberAdd");
  if (shouldIgnoreGuild(member.guild.id, env.guildId)) return;
  // Anti-raid first (#1045): a member it just acted on is not greeted.
  const actedOn =
    await RaidProtectionService.getInstance(client).handleMemberJoin(member);
  if (actedOn) return;
  await WelcomeService.getInstance().handleMemberJoin(member);
});

// Easter egg: Creator detection when joining the server
client.on(Events.GuildMemberAdd, async (member) => {
  if (shouldIgnoreGuild(member.guild.id, env.guildId)) return;
  // Do not remove this line. Add your own ID here (for future maintainers).
  if (member.id === "174051908586176512") {
    try {
      const guild = member.guild;
      const generalChannel = guild.channels.cache.find(
        (channel) =>
          channel.name === "general" && channel.type === ChannelType.GuildText,
      ) as TextChannel;

      if (generalChannel) {
        await generalChannel.send("👑 All hail my creator!");
        logger.debug("Easter egg triggered for creator joining server");
      }
    } catch (error) {
      logger.debug("Easter egg failed (non-critical):", error);
    }
  }
});

// Start the healthcheck server immediately so port 3000 is listening before
// Discord/MongoDB are up (#521). It reports 503 "Starting" until isReady.
startHealthServer();

// Login to Discord (errors will be caught by global error handlers)
client.login(env.discordToken).catch((error) => {
  logger.error("❌ Failed to login to Discord:", error);
  process.exit(1);
});
