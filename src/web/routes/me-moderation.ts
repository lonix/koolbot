/**
 * The moderator's pages (#1320): `/me/moderation`, `/me/moderation/audit` and
 * `/me/moderation/cases/:id`.
 *
 * Mounted by `createUserRouter` behind `requireSession`, the `/me` write
 * limiter and `requireScopeMiddleware("moderator")`; this router adds CSRF on
 * every unsafe method itself. It is the ONLY moderation surface a person
 * without the admin role reaches: it holds no setting, no `/admin` link and no
 * write apart from a case decision, which goes through the same
 * `decideCase` as the admin page (same service call, same audit row).
 *
 * Reads share their queries with the admin pages (`moderation-log-data.ts`,
 * `ModerationService`, `ModerationCaseService`). Nothing here reads message
 * content or attachments: a log row is the member, the moderator, the action
 * and the reason, exactly as the admin log shows it.
 */

import { Router, type Request, type Response } from "express";
import type { Client } from "discord.js";
import { env } from "../../config/env.js";
import { ConfigService } from "../../services/config-service.js";
import { ModerationService } from "../../services/moderation-service.js";
import { ModerationCaseService } from "../../services/moderation-case-service.js";
import { RoleGroupService } from "../../services/role-group-service.js";
import {
  SYSTEM_ACTOR,
  type IModerationCase,
} from "../../models/moderation-case.js";
import { COMPONENT_AUDIT_LABELS } from "../../utils/component-audit.js";
import logger from "../../utils/logger.js";
import {
  boundAuditEntry,
  recordAudit as recordAuditUnbounded,
  type AuditEntry,
} from "../audit.js";
import { requireCsrf } from "../csrf.js";
import { getDisplayedRemainingMs } from "../admin-layout.js";
import { readMeSurfaceFlags } from "../me-surfaces.js";
import { renderUserPage } from "../user-layout.js";
import { readSignedFlash } from "../http-flash.js";
import { hasScope, type AuthenticatedRequest } from "../session.js";
import { fetchChannelData } from "../read-only-routes.js";
import { buildCaseView, loadCaseHistory } from "../moderation-case-groups.js";
import {
  effectivePage,
  logRowUserIds,
  loadCommandAuditPage,
  readCommandAuditFilters,
  resolveMemberLabels,
  toModerationRows,
} from "../moderation-log-data.js";
import { CASE_DECISIONS, decideCase } from "../moderation-case-actions.js";
import {
  MOD_BASE,
  MOD_LOG_KIND_ACTIONS,
  parseModLogKind,
  renderModAuditBody,
  renderModCaseBody,
  renderModCaseMissingBody,
  renderModLogBody,
  type ModeratorReason,
  type OpenCaseItem,
} from "../me-moderation-page.js";
import { flashRedirect } from "./write/helpers.js";
import type { IModerationLog } from "../../models/moderation-log.js";

const PAGE_SIZE = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The ids and notes come from the moderator, and failed requests are audited
// too, so every row written here is bounded first (#1142).
const recordAudit = (
  session: Parameters<typeof recordAuditUnbounded>[0],
  entry: AuditEntry,
): Promise<void> => recordAuditUnbounded(session, boundAuditEntry(entry));

function csrfOf(req: Request): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

function pageOf(req: Request): number {
  const raw = Number.parseInt(String(req.query.page ?? "1"), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Members who cannot talk right now, from the guild member cache. The log does
 * not store how long a timeout lasts, so it cannot answer this. The cache is
 * only complete with the Server Members intent, and even then only once every
 * member is cached; otherwise the answer is "not known", never a wrong number.
 */
export async function countActiveTimeouts(
  client: Client,
  guildId: string,
): Promise<number | null> {
  if (!env.guildMembersIntent) return null;
  try {
    const guild = await client.guilds.fetch(guildId);
    // The intent does not mean the cache is full (a large guild is still
    // filling after startup): count only when every member is cached, as the
    // server scan does, otherwise an uncached member's timeout is missed and
    // the tile would read a confident, wrong number.
    if (guild.members.cache.size < guild.memberCount) return null;
    const now = Date.now();
    let n = 0;
    for (const member of guild.members.cache.values()) {
      if ((member.communicationDisabledUntilTimestamp ?? 0) > now) n += 1;
    }
    return n;
  } catch (err) {
    logger.debug("mod log: timeout count failed", err);
    return null;
  }
}

/**
 * Why this person holds the Moderator scope: the names of the role groups
 * that carry the `staff` capability and whose role they have, for the page
 * header. Best effort: any failure just leaves the capability label.
 */
async function moderatorReason(
  client: Client,
  session: NonNullable<AuthenticatedRequest["webSession"]>,
): Promise<ModeratorReason> {
  if (session.role === "admin") return { kind: "admin" };
  try {
    const guild = await client.guilds.fetch(session.guildId);
    const member = guild.members.cache.get(session.discordUserId);
    const groups = await RoleGroupService.getInstance().list(session.guildId);
    const names = groups
      .filter(
        (g) =>
          g.roleId !== null &&
          g.capabilities.some((c) => c === "staff" || c === "admin") &&
          member?.roles.cache.has(g.roleId),
      )
      .map((g) => g.name);
    return { kind: "groups", names };
  } catch (err) {
    logger.debug("mod log: could not name the moderator groups", err);
    return { kind: "groups", names: [] };
  }
}

export function createMeModerationRouter(client: Client): Router {
  const router = Router();
  router.use(requireCsrf);

  const wrap = async (
    req: Request,
    res: Response,
    title: string,
    body: string,
    status = 200,
    active: string = MOD_BASE,
  ): Promise<void> => {
    const session = (req as AuthenticatedRequest).webSession;
    const flags = await readMeSurfaceFlags();
    res
      .status(status)
      .type("text/html")
      .send(
        renderUserPage({
          title,
          active,
          body,
          csrfToken: csrfOf(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session?.role === "admin",
          flash: readSignedFlash(req.query),
          ...flags,
        }),
      );
  };

  const guarded =
    (
      fn: (
        req: Request,
        res: Response,
        session: NonNullable<AuthenticatedRequest["webSession"]>,
      ) => Promise<void>,
    ) =>
    (req: Request, res: Response, next: (err?: unknown) => void): void => {
      const session = (req as AuthenticatedRequest).webSession;
      // The `/moderation` guard already refused anyone without the scope; this
      // is the belt to its braces, so a mount mistake fails closed.
      if (!session || !hasScope(session, "moderator")) {
        res.status(403).type("text/plain").send("Forbidden");
        return;
      }
      fn(req, res, session).catch(next);
    };

  // ---------- Mod log ----------
  router.get(
    "/",
    guarded(async (req, res, session) => {
      const { guildId } = session;
      const reason = await moderatorReason(client, session);
      const kind = parseModLogKind(req.query.kind);
      const requestedPage = pageOf(req);
      // Strict reads: a failed lookup goes to the error handler instead of
      // reading as "moderation is off" or "cases are off".
      const enabled = await ConfigService.getInstance().getBooleanStrict(
        "moderation.enabled",
        false,
      );
      if (!enabled) {
        await wrap(
          req,
          res,
          "Mod log",
          renderModLogBody({
            reason,
            enabled: false,
            casesEnabled: false,
            tiles: {
              openCases: null,
              overdueCases: null,
              actionsLast7Days: null,
              timeoutsNow: null,
            },
            openCases: null,
            kind,
            rows: [],
            rowsUnavailable: false,
            caseLookupFailed: false,
            total: 0,
            page: 1,
            pageSize: PAGE_SIZE,
          }),
        );
        return;
      }

      const moderation = ModerationService.getInstance(client);
      const cases = ModerationCaseService.getInstance(client);
      const actions = MOD_LOG_KIND_ACTIONS[kind];
      const since = new Date(Date.now() - 7 * MS_PER_DAY);
      const casesEnabled = await cases.isEnabledStrict();

      // A failed read is "unavailable", never an empty list or a zero count:
      // the empty state is for a read that succeeded and found nothing.
      let logUnavailable = false;
      // Count first, so the page that is fetched is the page that is shown.
      const total = await moderation
        .countRecent(guildId, { actions })
        .catch(() => {
          logUnavailable = true;
          return 0;
        });
      const page = effectivePage(requestedPage, total, PAGE_SIZE);
      const [docs, actions7d, timeoutsNow, liveCount, overdueCount, queue] =
        await Promise.all([
          moderation
            .getRecent(guildId, {
              actions,
              limit: PAGE_SIZE,
              skip: (page - 1) * PAGE_SIZE,
            })
            .catch(() => {
              logUnavailable = true;
              return [] as IModerationLog[];
            }),
          moderation
            .countRecent(guildId, { since })
            .then((n): number | null => n)
            .catch((): number | null => null),
          countActiveTimeouts(client, guildId),
          casesEnabled
            ? cases
                .countLiveCases(guildId)
                .then((n): number | null => n)
                .catch((): number | null => null)
            : Promise.resolve<number | null>(null),
          casesEnabled
            ? cases
                .countOverdueCases(guildId)
                .then((n): number | null => n)
                .catch((): number | null => null)
            : Promise.resolve<number | null>(null),
          casesEnabled ? cases.getQueue(guildId).catch(() => null) : null,
        ]);

      let caseLookupFailed = false;
      const casesByEntry = casesEnabled
        ? await cases
            .getCasesForEntries(
              guildId,
              docs.map((d) => d._id as never),
            )
            .catch(() => {
              caseLookupFailed = true;
              return new Map<string, IModerationCase>();
            })
        : new Map<string, IModerationCase>();

      const openRaw: IModerationCase[] = queue
        ? [
            ...queue.overdue,
            ...queue.dueSoon,
            ...queue.scheduled,
            ...queue.indefinite,
          ]
        : [];
      const ids = logRowUserIds(docs, guildId);
      for (const c of openRaw) ids.add(c.userId);
      const labels = await resolveMemberLabels(
        client,
        guildId,
        ids,
        new Map([[guildId, "Server (anti-raid)"]]),
      );

      const now = Date.now();
      const openCases: OpenCaseItem[] | null = queue
        ? openRaw.map((c) => ({
            id: String(c._id),
            caseNumber: c.caseNumber,
            userId: c.userId,
            userLabel: labels.get(c.userId) ?? c.userId,
            action: c.action,
            status: c.status,
            reviewAt:
              c.reviewAt instanceof Date
                ? c.reviewAt.toISOString()
                : c.reviewAt
                  ? String(c.reviewAt)
                  : null,
            due:
              c.status === "under_review" ||
              (c.reviewAt instanceof Date && c.reviewAt.getTime() <= now),
          }))
        : null;

      await wrap(
        req,
        res,
        "Mod log",
        renderModLogBody({
          reason,
          enabled: true,
          casesEnabled,
          tiles: {
            openCases: liveCount,
            overdueCases: overdueCount,
            actionsLast7Days: actions7d,
            timeoutsNow,
          },
          openCases,
          kind,
          rows: toModerationRows(docs, casesByEntry, labels),
          rowsUnavailable: logUnavailable,
          caseLookupFailed,
          total,
          page,
          pageSize: PAGE_SIZE,
        }),
      );
    }),
  );

  // ---------- One case ----------
  router.get(
    "/cases/:id",
    guarded(async (req, res, session) => {
      const { guildId } = session;
      const reason = await moderatorReason(client, session);
      const cases = ModerationCaseService.getInstance(client);
      const casesEnabled = await cases.isEnabledStrict();
      // A failed lookup must not read as "no such case": it is left to throw.
      const found = casesEnabled
        ? await cases.findCase(guildId, String(req.params.id))
        : null;
      if (!found) {
        await wrap(
          req,
          res,
          "Case not found",
          renderModCaseMissingBody(reason, casesEnabled),
          404,
        );
        return;
      }
      const moderation = ModerationService.getInstance(client);
      // Left to throw: without the origin entry the reason would read as
      // "No reason recorded", which is a different claim.
      const originEntries = await cases.getOriginEntries([found]);
      let historyUnavailable = false;
      const history = await loadCaseHistory(
        moderation,
        guildId,
        [found],
        originEntries,
        () => {
          historyUnavailable = true;
        },
      );
      const ids = new Set<string>([found.userId, found.openedByUserId]);
      if (found.originModeratorId) ids.add(found.originModeratorId);
      for (const e of found.events) {
        // The review job records itself as "system", which is not a snowflake.
        if (e.byUserId !== SYSTEM_ACTOR) ids.add(e.byUserId);
      }
      const labels = await resolveMemberLabels(client, guildId, ids);
      const view = buildCaseView(found, originEntries, history, (id) =>
        id ? (labels.get(id) ?? id) : "Unknown",
      );
      await wrap(
        req,
        res,
        `Case #${found.caseNumber}`,
        renderModCaseBody({
          reason,
          csrfToken: csrfOf(req),
          case: { ...view, historyUnavailable },
          defaultReviewDays: await cases.getDefaultReviewDays(),
        }),
      );
    }),
  );

  // Review: the same decision, service call and audit row as the admin page.
  for (const decision of CASE_DECISIONS) {
    router.post(
      `/cases/:id/${decision}`,
      guarded(async (req, res, session) => {
        const caseId = String(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await decideCase({
          client,
          session,
          caseId,
          decision,
          get: (name) => {
            const raw = body[name];
            return typeof raw === "string" ? raw.trim() : "";
          },
          audit: recordAudit,
        });
        flashRedirect(
          res,
          `${MOD_BASE}/cases/${encodeURIComponent(caseId)}`,
          result,
        );
      }),
    );
  }

  // ---------- Command audit (read only: there is no write route here) ----------
  router.get(
    "/audit",
    guarded(async (req, res, session) => {
      const { guildId } = session;
      const reason = await moderatorReason(client, session);
      const config = ConfigService.getInstance();
      const requestedPage = pageOf(req);
      const filters = readCommandAuditFilters(
        req.query as Record<string, unknown>,
      );
      const channelData = await fetchChannelData(client, guildId);
      const [enabled, audit] = await Promise.all([
        config.getBooleanStrict("core.command_audit.enabled", true),
        loadCommandAuditPage({
          client,
          guildId,
          filters,
          page: requestedPage,
          pageSize: PAGE_SIZE,
          channelNames: channelData.names,
          channelTypes: channelData.types,
          channelsListed: channelData.listed,
        }),
      ]);
      await wrap(
        req,
        res,
        "Command audit",
        renderModAuditBody({
          reason,
          enabled,
          commandOptions: [
            ...Array.from(client.commands?.keys() ?? []).sort(),
            ...COMPONENT_AUDIT_LABELS,
          ],
          userOptions: audit.userOptions,
          filters,
          rows: audit.rows,
          unavailable: audit.unavailable,
          total: audit.total,
          page: audit.page,
          pageSize: PAGE_SIZE,
        }),
        200,
        `${MOD_BASE}/audit`,
      );
    }),
  );

  return router;
}
