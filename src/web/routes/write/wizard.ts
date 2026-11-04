/**
 * Setup Wizard — per-feature guided configuration.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { ConfigService } from "../../../services/config-service.js";
import {
  WizardService,
  type WizardRoleCreation,
  type WizardRoleMatch,
  type WizardState,
} from "../../../services/wizard-service.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import {
  accessFingerprint,
  accessGaps,
  accessRoleOverlap,
  applyAccessChanges,
  currentMapping,
  diffAccess,
  emptySelection,
  normaliseSelection,
  pickableRoles,
  readAccessContext,
  rollbackAccess,
  validateSelection,
  ACCESS_SCOPES,
  type AccessChange,
  type AccessContext,
  type AccessDeps,
  type AccessGap,
  type AccessSelection,
  type AccessUndo,
} from "../../../services/wizard-access.js";
import { ROLE_GRANTING_SETTINGS } from "../../../services/role-grants.js";
import {
  renderWizardAccessPage,
  type ReviewRoleMatch,
} from "../../wizard-access-view.js";
import { renderWizardDonePage } from "../../wizard-done-view.js";
import { ADMIN_CONTINUE_FIELD } from "../../wizard-admin-view.js";
import { loadPermissionReport } from "../../permission-notice.js";
import {
  administratorInviteUrl,
  checkBotAdministrator,
} from "../../../services/wizard-admin-check.js";
import {
  defaultConfig,
  settingsMetadata,
  getDependencies,
  isEnabledValue,
} from "../../../services/config-schema.js";
import { getEnvConfigValue } from "../../../config/env.js";
import { FLASH_MAX, signFlash, readSignedFlash } from "../../http-flash.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import {
  renderWizardPage,
  renderWizardStepPage,
  renderWizardConfirmPage,
  type WizardAdminProps,
  readSettingField,
  wantsKeptColour,
  KEEP_READ_FAILED_REASON,
  settingValueFieldName,
} from "../../admin-views.js";
import {
  fetchChannelData,
  fetchReactionRoleMessages,
  fetchRoleData,
  withRoleGroupOptions,
} from "../../read-only-routes.js";
import { ROLE_GROUP_SETTING_KEYS } from "../../../services/role-group-access.js";
import {
  flashRedirect,
  flashRedirectQuery,
  requireSessionContext,
  asyncHandler,
  getCsrfFromReq,
  navStatusForPage,
  WIZARD_FEATURE_SETTINGS,
  WIZARD_FEATURE_ORDER,
  wizardOffGates,
  wizardApplyFailureMessage,
  wizardApplyFailureReason,
  coerceConfigValueForGuild,
  isReactionRoleMessageKey,
  readReactionRoleMessageBaseline,
  findGroupRoleReuseForSetting,
  guardedRoleIds,
  findPowerfulRoleForSetting,
  truncateFlash,
} from "./helpers.js";
import {
  planWizardDependencies,
  type WizardDependencyPlan,
} from "./wizard-dependencies.js";
import {
  canBotCreate,
  toPickerCreate,
} from "../../../services/bot-create-check.js";
import { createKindOf } from "../../setting-create.js";
import {
  loadCreateCategoryAnswer,
  loadCreateChannelAnswer,
} from "../../setting-create-load.js";
import {
  parsePickerCreateValue,
  pickerCreateValue,
} from "../../setting-pickers.js";
import {
  applyWizardRoles,
  contextWithNew,
  draftCreations,
  pendingNames,
  resolvePicks,
  reviewWizardRoles,
  selectionWithNew,
  splitPicks,
  swapPlaceholders,
  type WizardRoleApply,
  reviewRoleMatches,
  type WizardRoleReview,
} from "../../wizard-role-create.js";
import {
  activeWizardCreations,
  applyWizardCreations,
  reviewWizardCreations,
  type CreatedForSetting,
  type WizardCreateReview,
} from "../../wizard-create.js";

/** The first pending role setting that names a role the Access step maps. */
function pendingConfigOverlap(
  configuration: Record<string, unknown>,
  selection: AccessSelection,
): string | null {
  for (const [key, value] of Object.entries(configuration)) {
    const hit = accessRoleOverlap(selection, guardedRoleIds(key, value), key);
    if (hit) return hit;
  }
  return null;
}

/** The wizard's features named in a query value (comma separated), in a form the page can tick again. */
function tickedFeatures(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [
    ...new Set(raw.split(",").filter((f) => WIZARD_FEATURE_ORDER.includes(f))),
  ];
}

/** Features whose scope the Access step can leave without anybody to run it. */
const GAP_FEATURES = ["events", "moderation"] as const;

/**
 * A flash that is cut to the mechanism's length (the text travels in the
 * redirect's query string, hence `FLASH_MAX`) without ever cutting `tail`.
 * Only `head` (the underlying error) is shortened, with an ellipsis, so what
 * became of the created channels, and their ids, always reaches the admin.
 */
export function flashKeepingTail(head: string, tail: string): string {
  if (head.length + tail.length <= FLASH_MAX) return head + tail;
  const room = FLASH_MAX - tail.length - 1;
  if (room <= 0) return truncateFlash(tail.trimStart());
  return `${head.slice(0, room).trimEnd()}…${tail}`;
}

/**
 * The recovery sentences of a failed apply, kept whole whenever they fit with
 * room left for the cause. When what the mapping rollback, the channel cleanup
 * and the role cleanup left behind does not fit in the 500-character flash,
 * they are replaced by ONE short sentence that still names what is left (each
 * list capped with "and N more", full lists are in the log) and says to check
 * it. Only the cause is ever shortened (`flashKeepingTail`).
 */
const MIN_CAUSE_ROOM = 150;
export function fitRecovery(
  long: string,
  left: { groups: string[]; roles: string[]; channels: string[] },
): string {
  if (long.length <= FLASH_MAX - MIN_CAUSE_ROOM) return long;
  const short = (v: string): string =>
    v.length > 24 ? `${v.slice(0, 23)}…` : v;
  const parts = [
    left.groups.length > 0
      ? `role groups ${idList(left.groups.map(short))}`
      : "",
    left.roles.length > 0 ? `roles ${idList(left.roles)}` : "",
    left.channels.length > 0 ? `channels ${idList(left.channels)}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return long.slice(0, FLASH_MAX - MIN_CAUSE_ROOM);
  return ` Left behind, check before applying again: ${parts.join("; ")}. Anything else this apply created was removed again.`;
}

/** At most `MAX_IDS_SHOWN` ids, then "and N more", so the cleanup text stays short enough to protect. */
const MAX_IDS_SHOWN = 2;
export function idList(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_IDS_SHOWN).join(", ");
  const more = ids.length - MAX_IDS_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * What one Apply reads from the wizard session, copied at its start. The
 * session object is the live one: a save in another tab changes it while this
 * Apply waits on a lock or on Discord, and an Apply must write only what its
 * own checks (and the fingerprint Review posted) saw.
 */
function snapshotState(live: WizardState): WizardState {
  return {
    ...live,
    selectedFeatures: [...live.selectedFeatures],
    configuration: { ...live.configuration },
    access: live.access ? globalThis.structuredClone(live.access) : undefined,
    roleCreations: globalThis.structuredClone(live.roleCreations ?? []),
    creations: globalThis.structuredClone(live.creations ?? {}),
  };
}

export function createWizardRouter(client: Client): Router {
  const router = Router();

  async function readAccess(session: {
    guildId: string;
    discordUserId: string;
  }): Promise<AccessContext> {
    const guild = await client.guilds.fetch(session.guildId);
    return readAccessContext(guild);
  }

  /**
   * Whether the bot has Administrator (#1617), for the first page and Review.
   * `refresh` reads the bot's membership from Discord (Check again); never throws.
   */
  async function readAdmin(
    session: { guildId: string },
    refresh: boolean,
  ): Promise<WizardAdminProps> {
    return {
      check: await checkBotAdministrator(client, session.guildId, { refresh }),
      inviteUrl: administratorInviteUrl(client),
    };
  }

  /**
   * Which gap-prone features end up switched on: what the admin set in this
   * wizard run, else the stored value for a feature being configured; a
   * feature left unticked is switched off by Apply.
   */
  async function enabledGapFeatures(state: {
    selectedFeatures: string[];
    configuration: Record<string, unknown>;
  }): Promise<Set<string>> {
    const out = new Set<string>();
    const config = ConfigService.getInstance();
    for (const fk of GAP_FEATURES) {
      const key = `${fk}.enabled`;
      const pending = state.configuration[key];
      const on =
        pending !== undefined
          ? isEnabledValue(pending)
          : state.selectedFeatures.includes(fk)
            ? await config.getBoolean(key, false)
            : false;
      if (on) out.add(fk);
    }
    return out;
  }

  /** The tools `applyAccessChanges` writes through, audited to this session. */
  function accessDeps(session: Parameters<typeof recordAudit>[0]): AccessDeps {
    return {
      groups: RoleGroupService.getInstance(),
      audit: async (entry): Promise<void> => {
        await recordAudit(session, entry);
      },
    };
  }

  // ============================================================
  // Setup Wizard (issue #383)
  // ============================================================

  router.get(
    "/wizard",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const csrfToken = getCsrfFromReq(req);
      const remainingMs = getDisplayedRemainingMs(session);
      const navFeatureStatus = await navStatusForPage();
      const wizard = WizardService.getInstance();
      const existing = wizard.getSession(
        session.discordUserId,
        session.guildId,
      );

      // POST /wizard/step/:n redirects here with `?flash=warn&msg=…` when
      // coercion drops fields. Surface it via the renderer.
      const flash = readSignedFlash(req.query);

      if (existing && Number(req.query.reset) !== 1) {
        const features = existing.selectedFeatures;
        const stepParam = req.query.step;

        if (typeof stepParam === "string" && stepParam === "access") {
          // The groups and Discord are read live, and a failed read is said
          // out loud: an empty list would look like "nobody is mapped".
          let ctx: AccessContext | null = null;
          try {
            ctx = await readAccess(session);
          } catch (err) {
            logger.warn("wizard: access step could not read the server", err);
          }
          // A refused save's picks and typed names, drawn once more and then
          // forgotten: they were never saved.
          const draft = existing.accessDraft;
          if (draft) {
            wizard.updateSession(session.discordUserId, session.guildId, {
              accessDraft: undefined,
            });
          }
          const selection =
            draft?.ids ??
            existing.access ??
            (ctx ? currentMapping(ctx.groups) : emptySelection());
          const planned = draft
            ? draftCreations(draft.named)
            : (existing.roleCreations ?? []);
          // The role Picker's create row (#1618): one permission answer for the
          // page. A role already chosen to be created stays drawn as pending
          // even when the answer is unreadable (no row, no line then).
          let create =
            ctx === null
              ? undefined
              : toPickerCreate(
                  "role",
                  await canBotCreate(client, session.guildId, {
                    kind: "role",
                  }),
                );
          if (!create && ctx && planned.length > 0) {
            create = { kind: "role", ok: false };
          }
          res.type("text/html").send(
            renderWizardAccessPage({
              csrfToken,
              remainingMs,
              navFeatureStatus,
              selection,
              options: ctx ? pickableRoles(ctx) : null,
              gaps: ctx
                ? accessGaps(
                    await enabledGapFeatures(existing),
                    selectionWithNew(selection, planned),
                  )
                : [],
              create,
              pending: pendingNames(planned),
              flash,
            }),
          );
          return;
        }

        if (typeof stepParam === "string" && stepParam === "confirm") {
          const pending = Object.entries(existing.configuration);
          let accessChanges: AccessChange[] = [];
          let accessProblem: string | null = null;
          let gaps: AccessGap[] = [];
          let fingerprint: string | undefined;
          let roleReview: WizardRoleReview | null = null;
          let roleMatches: ReviewRoleMatch[] = [];
          if (existing.access) {
            try {
              const ctx = await readAccess(session);
              const planned = existing.roleCreations ?? [];
              accessProblem = validateSelection(ctx, existing.access);
              // A role that does not exist yet stands in as a placeholder, so
              // the same diff maps it (see `wizard-role-create.ts`).
              const mapped = selectionWithNew(existing.access, planned);
              accessChanges = diffAccess(
                ctx.groups,
                contextWithNew(ctx, planned).roles,
                mapped,
              );
              fingerprint = accessFingerprint(accessChanges);
              gaps = accessGaps(
                await enabledGapFeatures(existing),
                selectionWithNew(existing.access, planned),
              );
              roleMatches = await reviewRoleMatches(
                client,
                session.guildId,
                existing.roleMatches ?? [],
              );
              if (planned.length > 0) {
                roleReview = await reviewWizardRoles(
                  client,
                  session.guildId,
                  ctx,
                  planned,
                );
              }
            } catch (err) {
              logger.warn("wizard: review could not read the server", err);
              accessProblem =
                "Discord or the role groups could not be read, so the role mapping can't be checked.";
            }
          }
          // What Apply would refuse or need confirmed (#1622), judged on the
          // batch Apply writes. A failed read says nothing here: Apply checks
          // again and refuses back to this page.
          let dependencies: WizardDependencyPlan | null = null;
          try {
            const cfg = ConfigService.getInstance();
            dependencies = await planWizardDependencies(
              existing.configuration,
              existing.selectedFeatures,
              (key) => cfg.getBooleanStrict(key, false),
            );
          } catch (err) {
            logger.warn("wizard: review could not check dependencies", err);
          }
          // The channels the steps plan to create (#1662), planned from the
          // live server with nothing written. Each setting that gets one is a
          // row of the table, with what it will point at.
          const createReview = await reviewWizardCreations(
            client,
            session.guildId,
            activeWizardCreations(existing, WIZARD_FEATURE_SETTINGS),
          ).catch((err: unknown): WizardCreateReview => {
            logger.warn("wizard: review could not plan the channels", err);
            return {
              creations: [],
              rows: [],
              planId: null,
              problems: [
                "The channels could not be planned, so Apply is blocked. Try again in a moment.",
              ],
            };
          });
          const admin = await readAdmin(session, req.query.recheck === "1");
          res.type("text/html").send(
            renderWizardConfirmPage({
              csrfToken,
              remainingMs,
              navFeatureStatus,
              admin,
              pending: [...pending, ...createReview.rows],
              creations: createReview.creations,
              createPlanId: createReview.planId,
              createProblems: createReview.problems,
              metadata: settingsMetadata,
              accessChanges,
              accessProblem,
              accessGaps: gaps,
              accessFingerprint: fingerprint,
              roleReview,
              roleMatches,
              dependencies,
              flash,
            }),
          );
          return;
        }

        const step =
          stepParam !== undefined ? parseInt(String(stepParam), 10) : -1;
        if (Number.isFinite(step) && step >= 0 && step < features.length) {
          const featureKey = features[step];
          const settingKeys = WIZARD_FEATURE_SETTINGS[featureKey] ?? [];
          const config = ConfigService.getInstance();

          // Read the store once and resolve every value from that snapshot.
          // `config.get` swallows read errors and returns `null`, which would
          // render as blank / unchecked controls that the apply step then
          // persists, so a failed read fails closed here instead, like the
          // Settings and feature pages do.
          const snapshot = await config.getAll().catch((err: unknown) => {
            logger.warn("wizard: config snapshot read failed", err);
            return null;
          });
          if (snapshot === null) {
            res.type("text/html").send(
              renderWizardStepPage({
                csrfToken,
                remainingMs,
                navFeatureStatus,
                stepIndex: step,
                featureKeys: features,
                featureKey,
                settingKeys,
                currentValues: {},
                metadata: settingsMetadata,
                defaultValues: defaultConfig as unknown as Record<
                  string,
                  unknown
                >,
                textChannels: [],
                voiceChannels: [],
                categoryChannels: [],
                roles: [],
                enabledByKey: {},
                flash,
                settingsUnavailable: true,
              }),
            );
            return;
          }

          const storedByKey = new Map(snapshot.map((r) => [r.key, r.value]));

          // Resolve a key's effective current value: prefer what the admin
          // already entered earlier in this wizard run, then the stored row
          // from the snapshot, then an env var named after the key (the order
          // `ConfigService.get` uses), then the schema default. Used for both
          // the visible fields and the cross-feature dependency targets below.
          const resolveCurrent = (k: string): unknown => {
            const fromWizard = wizard.getConfiguration(
              session.discordUserId,
              session.guildId,
              k,
            );
            if (fromWizard !== undefined) return fromWizard;
            if (storedByKey.has(k)) return storedByKey.get(k);
            return (
              getEnvConfigValue(k) ??
              defaultConfig[k as keyof typeof defaultConfig]
            );
          };

          // The Picker's create row (#1662): one permission answer for the
          // step, asked only when a flagged channel setting is on it.
          const pickerCreate = await loadCreateChannelAnswer(
            client,
            session.guildId,
            settingKeys,
          );
          // The same for a category setting of the step (#1664).
          const pickerCreateCategory = await loadCreateCategoryAnswer(
            client,
            session.guildId,
            settingKeys,
          );

          const currentValues: Record<string, unknown> = {};
          for (const k of settingKeys) {
            currentValues[k] = resolveCurrent(k);
            // A channel planned on an earlier visit is drawn again as the
            // pending option; without the row (permissions unreadable) the
            // step shows the stored value and the admin chooses again.
            const planned = existing.creations?.[k];
            const kind = createKindOf(k);
            // A planned category is drawn as pending even when the permission
            // could not be read (the Picker then shows no row and no help line),
            // so the step agrees with Review.
            if (
              planned &&
              planned.kind === kind &&
              (kind === "category" || pickerCreate)
            ) {
              currentValues[k] = pickerCreateValue(planned.name);
            }
          }

          // Enabled-state of this step's keys plus any dependency targets they
          // reference on other steps (e.g. `achievements.enabled` depends on
          // `voicetracking.enabled`), so the shared dependency-lock logic knows
          // whether a cross-feature requirement is actually satisfied (#666).
          const enabledByKey: Record<string, boolean> = {};
          for (const k of settingKeys) {
            enabledByKey[k] = isEnabledValue(currentValues[k]);
          }
          for (const k of settingKeys) {
            for (const dep of getDependencies(
              k as keyof typeof defaultConfig,
            )) {
              if (dep in enabledByKey) continue;
              enabledByKey[dep] = isEnabledValue(resolveCurrent(dep));
            }
          }
          // Guild picker lists so channel/category/role keys render as real
          // selectors, exactly like the Settings page (issues #702 / #703).
          // Two guild fetches run in parallel — one for channels/categories,
          // one for roles; both helpers swallow their own errors and return
          // empty lists, so a picker just falls back to an empty dropdown
          // rather than failing the step.
          const [chData, roleData] = await Promise.all([
            fetchChannelData(client, session.guildId),
            fetchRoleData(client, session.guildId),
          ]);
          // `quotes.delete_roles` also takes role groups (#1023).
          const groupRoles = settingKeys.some((k) =>
            (ROLE_GROUP_SETTING_KEYS as readonly string[]).includes(k),
          )
            ? await withRoleGroupOptions(session.guildId, roleData.roles)
            : undefined;
          // The welcome step picks its roles message from the bot's own
          // reaction-role messages (#1433).
          const reactionRoleMessages = settingKeys.some((k) =>
            isReactionRoleMessageKey(k),
          )
            ? await fetchReactionRoleMessages(session.guildId, chData)
            : undefined;
          res.type("text/html").send(
            renderWizardStepPage({
              csrfToken,
              remainingMs,
              navFeatureStatus,
              stepIndex: step,
              featureKeys: features,
              featureKey,
              settingKeys,
              currentValues,
              metadata: settingsMetadata,
              defaultValues: defaultConfig as unknown as Record<
                string,
                unknown
              >,
              textChannels: chData.textChannels,
              voiceChannels: chData.voiceChannels,
              categoryChannels: chData.categoryChannels,
              roles: roleData.roles,
              groupRoles,
              reactionRoleMessages,
              pickerCreate,
              pickerCreateCategory,
              enabledByKey,
              flash,
            }),
          );
          return;
        }
      }

      // Step 0: feature selection. Show the current feature.enabled state
      // alongside each card so the operator knows what's already on.
      const config = ConfigService.getInstance();
      const featureStatus: Record<string, boolean> = {};
      for (const fk of WIZARD_FEATURE_ORDER) {
        const keys = WIZARD_FEATURE_SETTINGS[fk] ?? [];
        const enabledKey = keys.find((k) => k.endsWith(".enabled"));
        featureStatus[fk] = enabledKey
          ? await config.getBoolean(enabledKey, false)
          : false;
      }
      res.type("text/html").send(
        renderWizardPage({
          csrfToken,
          remainingMs,
          navFeatureStatus,
          featureOrder: WIZARD_FEATURE_ORDER,
          featureStatus,
          admin: await readAdmin(session, req.query.recheck === "1"),
          ticked: tickedFeatures(req.query.ticked),
        }),
      );
    }),
  );

  // Check again on the first page (#1617): the ticked features are the only
  // choices there, so they travel through the redirect and are ticked again.
  // Nothing is saved.
  router.post(
    "/wizard/check",
    asyncHandler(async (req, res) => {
      requireSessionContext(req);
      const raw = (req.body as Record<string, unknown> | undefined)?.features;
      const ticked = tickedFeatures(
        (Array.isArray(raw) ? raw : [raw]).map(String).join(","),
      );
      res.redirect(
        303,
        `/admin/wizard?recheck=1${
          ticked.length > 0
            ? `&ticked=${encodeURIComponent(ticked.join(","))}`
            : ""
        }`,
      );
    }),
  );

  // The page the wizard ends on (#1617): the optional step that narrows the
  // bot's permissions. It reads and explains; it changes nothing in Discord.
  router.get(
    "/wizard/done",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const [report, admin, navFeatureStatus] = await Promise.all([
        loadPermissionReport({ client, guildId: session.guildId }),
        checkBotAdministrator(client, session.guildId),
        navStatusForPage(),
      ]);
      res.type("text/html").send(
        renderWizardDonePage({
          csrfToken: getCsrfFromReq(req),
          remainingMs: getDisplayedRemainingMs(session),
          navFeatureStatus,
          report,
          admin,
          flash: readSignedFlash(req.query),
        }),
      );
    }),
  );

  router.post(
    "/wizard/start",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const rawFeatures = (req.body as Record<string, unknown> | undefined)
        ?.features;
      const features: string[] = (
        Array.isArray(rawFeatures) ? rawFeatures : [rawFeatures]
      )
        .map(String)
        .filter((f) => WIZARD_FEATURE_ORDER.includes(f));

      if (features.length === 0) {
        flashRedirect(res, "/admin/wizard", {
          type: "err",
          text: "Pick at least one feature to configure.",
        });
        return;
      }

      const wizard = WizardService.getInstance();
      // `createSession` silently replaces any pre-existing session for the
      // same user/guild. Snapshot the prior state first so the audit row
      // records what was discarded — an operator restarting their own
      // wizard is fine, but an admin clobbering someone else's progress
      // needs to be traceable.
      const prior = wizard.getSession(session.discordUserId, session.guildId);
      const replacedExisting = prior !== null;
      const discardedKeys = prior ? Object.keys(prior.configuration) : [];
      wizard.createSession(session.discordUserId, session.guildId, features);
      await recordAudit(session, {
        action: "wizard.start",
        details: { features, replacedExisting, discardedKeys },
        result: "success",
      });
      res.redirect(303, "/admin/wizard?step=access");
    }),
  );

  // The Access step (#1321). Saving only remembers the picks in the wizard
  // session; roles and role groups are written by Apply, after the review.
  router.post(
    "/wizard/access",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(session.discordUserId, session.guildId);
      if (!state) {
        flashRedirect(res, "/admin/wizard", {
          type: "warn",
          text: "Wizard session expired. Please start again.",
        });
        return;
      }
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      // The `create:` values are taken out first, before anything reads the
      // picks as ids (`splitPicks`); a name is never coerced or stored as a pick.
      const picks = splitPicks({
        admin: body["roles_admin"],
        staff: body["roles_staff"],
        host: body["roles_host"],
      });
      let selection: AccessSelection = normaliseSelection(picks.ids);
      let creations: WizardRoleCreation[] = [];
      let matches: WizardRoleMatch[] = [];
      const stay = (text: string): void => {
        // Nothing is saved, but what was posted is kept for the next page
        // load (once), so the admin does not retype it.
        wizard.updateSession(session.discordUserId, session.guildId, {
          accessDraft: { ids: picks.ids, named: picks.named },
        });
        res.redirect(
          303,
          `/admin/wizard?step=access&${flashRedirectQuery({ type: "warn", text })}`,
        );
      };
      let problem: string | null = picks.errors[0] ?? null;
      if (!problem) {
        try {
          const ctx = await readAccess(session);
          if (picks.named.length > 0) {
            // Nothing is created for a refused or unreadable permission: the
            // reason is the answer, and the save stops here.
            const can = await canBotCreate(client, session.guildId, {
              kind: "role",
            });
            if (can.ok === false) problem = can.reason;
            else if (can.ok !== true) {
              problem =
                "KoolBot could not check whether it may create roles. Try again.";
            }
          }
          if (!problem) {
            const resolved = resolvePicks(picks, ctx.roles);
            if (!resolved.ok) {
              problem = resolved.error;
            } else {
              selection = resolved.selection;
              creations = resolved.creations;
              matches = resolved.matches;
            }
          }
          if (!problem) {
            problem =
              validateSelection(ctx, selection) ??
              pendingConfigOverlap(state.configuration, selection);
          }
        } catch (err) {
          logger.warn("wizard: access picks could not be checked", err);
          await recordAudit(session, {
            action: "wizard.access",
            details: { selection },
            result: "failure",
            errorMessage: "Discord or the role groups could not be read",
          });
          stay(
            "Discord or the role groups could not be read, so nothing was saved. Try again in a moment.",
          );
          return;
        }
      }
      if (problem) {
        await recordAudit(session, {
          action: "wizard.access",
          details: { selection },
          result: "failure",
          errorMessage: problem,
        });
        stay(problem);
        return;
      }
      wizard.setAccess(
        session.discordUserId,
        session.guildId,
        selection,
        creations,
        matches,
      );
      await recordAudit(session, {
        action: "wizard.access",
        details: {
          selection,
          createRoles: creations.map((c) => c.name),
          counts: Object.fromEntries(
            ACCESS_SCOPES.map((sc) => [sc, selection[sc].length]),
          ),
        },
        result: "success",
      });
      res.redirect(303, "/admin/wizard?step=0");
    }),
  );

  router.post(
    "/wizard/step/:n",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(session.discordUserId, session.guildId);
      if (!state) {
        flashRedirect(res, "/admin/wizard", {
          type: "warn",
          text: "Wizard session expired. Please start again.",
        });
        return;
      }

      const stepIndex = parseInt(String(req.params.n), 10);
      if (
        !Number.isFinite(stepIndex) ||
        stepIndex < 0 ||
        stepIndex >= state.selectedFeatures.length
      ) {
        flashRedirect(res, "/admin/wizard", {
          type: "err",
          text: "Invalid wizard step.",
        });
        return;
      }

      const featureKey = state.selectedFeatures[stepIndex];
      const settingKeys = WIZARD_FEATURE_SETTINGS[featureKey] ?? [];

      // Cascading disable (#485): when the feature's master `.enabled` toggle
      // is off, the dependent controls were greyed out client-side and aren't
      // submitted. Mirror that on the server — record only `<feature>.enabled
      // = false` and skip the rest, so absent dependents don't surface as
      // bogus "invalid input" drops (a missing number field would otherwise
      // fail coercion).
      // The wizard now renders each control through the shared
      // `renderControlInput`, which names every value field `value_<key>`
      // (`settingValueFieldName`) exactly like the Settings page — read the
      // same field names back here (issues #702 / #703).
      const body = req.body as Record<string, unknown> | undefined;
      const masterKey = `${featureKey}.enabled`;
      const masterOff =
        settingKeys.includes(masterKey) &&
        body?.[settingValueFieldName(masterKey)] !== "true";

      const saved: Record<string, unknown> = {};
      const dropped: Array<{ key: string; reason: string }> = [];
      // The permission to create, asked once and only if a create value is
      // posted for a flagged setting (#1662).
      const createAnswers = new Map<
        "text" | "category",
        Awaited<ReturnType<typeof canBotCreate>>
      >();
      const dropCreation = (k: string): void => {
        if (state.creations?.[k]) {
          wizard.removeCreation(session.discordUserId, session.guildId, k);
        }
      };
      for (const k of settingKeys) {
        if (masterOff && k !== masterKey) {
          dropCreation(k);
          // The control was greyed out and not submitted, but an earlier visit
          // to this step may have staged a value for it. A staged `true` (or
          // any value other than `false`) is dropped, so Review's dependency
          // check reads the live value instead of taking a stale enable for the
          // admin's choice (#1622). A staged `false` is an explicit disable
          // (`aka.enabled` has its own gate) and stays. Other features'
          // choices are not touched.
          if (state.configuration[k] === false) continue;
          wizard.removeConfiguration(session.discordUserId, session.guildId, k);
          continue;
        }
        // A channel to be created (#1662) is read before anything else touches
        // the posted value: only a flagged channel setting takes one, and it is
        // taken out here, so a `create:` value never reaches the CSV join or
        // the coercion (which refuses it for every other key). The channel is
        // created by Apply, from Review.
        const posted = body?.[settingValueFieldName(k)];
        const createKind = createKindOf(k);
        if (createKind && typeof posted === "string") {
          const named = parsePickerCreateValue(posted);
          if (named) {
            if (!named.ok) {
              dropped.push({ key: k, reason: named.error });
              continue;
            }
            let createAnswer = createAnswers.get(createKind);
            if (!createAnswer) {
              createAnswer = await canBotCreate(
                client,
                session.guildId,
                createKind === "category"
                  ? { kind: "category" }
                  : { kind: "channel" },
              );
              createAnswers.set(createKind, createAnswer);
            }
            if (createAnswer.ok !== true) {
              dropped.push({
                key: k,
                reason:
                  createAnswer.ok === false
                    ? createAnswer.reason
                    : `KoolBot could not check whether it may create ${createKind === "category" ? "categories" : "channels"}. Try again.`,
              });
              continue;
            }
            wizard.setCreation(session.discordUserId, session.guildId, k, {
              name: named.name,
              kind: createKind,
            });
            saved[k] = pickerCreateValue(named.name);
            continue;
          }
        }
        const current = await ConfigService.getInstance()
          .get(k)
          .catch(() => undefined);
        // Keep resolves against a strict read (see the Settings save): a
        // failed read must not stage the swatch placeholder instead.
        let kept = current;
        if (wantsKeptColour(body, k)) {
          try {
            kept = await ConfigService.getInstance().getStringStrict(k);
          } catch {
            dropped.push({ key: k, reason: KEEP_READ_FAILED_REASON });
            continue;
          }
        }
        // A reaction-role message key (#1433) is read strictly too: its
        // exemption for an unchanged value rests on the stored value, which
        // must be the database's, never one staged earlier in this wizard run.
        if (isReactionRoleMessageKey(k)) {
          const baseline = await readReactionRoleMessageBaseline(k);
          if (!baseline.ok) {
            dropped.push({ key: k, reason: baseline.reason });
            continue;
          }
          kept = baseline.value;
        }
        const raw = readSettingField(body, k, kept);
        const coerced = await coerceConfigValueForGuild(
          k,
          raw,
          kept,
          session.guildId,
        );
        // A role that backs a role group can't be picked for another
        // feature (#1023); the same guard as the Settings page.
        const stored = coerced.ok ? kept : undefined;
        // Also refuse a role with Administrator or other powerful
        // permissions (#1145).
        const reuse = coerced.ok
          ? ((state.access
              ? accessRoleOverlap(
                  state.access,
                  guardedRoleIds(k, coerced.value),
                  k,
                )
              : null) ??
            (await findGroupRoleReuseForSetting(
              session.guildId,
              k,
              coerced.value,
              stored,
            )) ??
            (await findPowerfulRoleForSetting(
              client,
              session.guildId,
              k,
              coerced.value,
              stored,
            )))
          : null;
        if (reuse) {
          dropped.push({ key: k, reason: reuse });
        } else if (coerced.ok) {
          dropCreation(k);
          wizard.addConfiguration(
            session.discordUserId,
            session.guildId,
            k,
            coerced.value,
          );
          saved[k] = coerced.value;
        } else {
          // Mirror the YAML-import principle: a coercion failure must not
          // be silent. The operator gets a flash on the *next* page and the
          // audit row records the dropped keys so misconfigured form input
          // is traceable.
          dropped.push({ key: k, reason: coerced.reason });
        }
      }

      await recordAudit(session, {
        action: "wizard.step",
        details: { stepIndex, featureKey, saved, dropped },
        result: dropped.length > 0 ? "failure" : "success",
        errorMessage:
          dropped.length > 0
            ? dropped.map((d) => `${d.key}: ${d.reason}`).join("; ")
            : null,
      });

      // On any coercion failure, keep the operator on the same step so they
      // can correct the input. Otherwise advance to the next step (or the
      // confirm page if this was the last one).
      if (dropped.length > 0) {
        const msg = `${dropped.length} field${dropped.length === 1 ? "" : "s"} ignored (invalid input): ${dropped
          .map((d) => `${d.key} (${d.reason})`)
          .join(", ")}.`;
        const truncated =
          msg.length > FLASH_MAX ? `${msg.slice(0, FLASH_MAX - 1)}…` : msg;
        const qs = new globalThis.URLSearchParams({
          step: String(stepIndex),
          flash: "warn",
          msg: truncated,
          sig: signFlash("warn", truncated),
        }).toString();
        res.redirect(303, `/admin/wizard?${qs}`);
        return;
      }

      const nextStep = stepIndex + 1;
      if (nextStep >= state.selectedFeatures.length) {
        res.redirect(303, "/admin/wizard?step=confirm");
      } else {
        res.redirect(303, `/admin/wizard?step=${nextStep}`);
      }
    }),
  );

  router.post(
    "/wizard/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const live = wizard.getSession(session.discordUserId, session.guildId);
      if (!live) {
        flashRedirect(res, "/admin/wizard", {
          type: "warn",
          text: "Wizard session expired. Please start again.",
        });
        return;
      }
      const state = snapshotState(live);

      // A step is checked when it is saved, but the wizard can stay open
      // while another admin links one of the chosen roles to a role group
      // (#1023). Check again right before anything is written, and apply
      // nothing if a role has become group-backed.
      for (const { key } of ROLE_GRANTING_SETTINGS) {
        if (!(key in state.configuration)) continue;
        const before = await ConfigService.getInstance()
          .get(key)
          .catch(() => undefined);
        // Also refuse a role with Administrator or other powerful
        // permissions (#1145).
        const reuse =
          (state.access
            ? accessRoleOverlap(
                state.access,
                guardedRoleIds(key, state.configuration[key]),
                key,
              )
            : null) ??
          (await findGroupRoleReuseForSetting(
            session.guildId,
            key,
            state.configuration[key],
            before,
          )) ??
          (await findPowerfulRoleForSetting(
            client,
            session.guildId,
            key,
            state.configuration[key],
            before,
          ));
        if (reuse) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: { blockedKey: key },
            result: "failure",
            errorMessage: `${key}: ${reuse}`,
          });
          flashRedirect(res, "/admin/wizard", {
            type: "err",
            text: `Nothing was applied. ${key}: ${reuse} Go back to that step and choose another role.`,
          });
          return;
        }
      }

      // A reaction-role message choice (#1433) is checked when its step is
      // saved, but the message's mappings can be archived while the wizard
      // stays open, and apply writes the staged id as it is. Check again
      // against the stored baseline and the guild's active messages, and
      // apply nothing if a read fails or a choice is no longer valid.
      for (const key of Object.keys(state.configuration)) {
        if (!isReactionRoleMessageKey(key)) continue;
        const baseline = await readReactionRoleMessageBaseline(key);
        const checked = baseline.ok
          ? await coerceConfigValueForGuild(
              key,
              state.configuration[key],
              baseline.value,
              session.guildId,
            )
          : baseline;
        if (!checked.ok) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: { blockedKey: key },
            result: "failure",
            errorMessage: `${key}: ${checked.reason}`,
          });
          flashRedirect(res, "/admin/wizard", {
            type: "err",
            text: `Nothing was applied. ${key}: ${checked.reason}. Go back to that step and choose again.`,
          });
          return;
        }
      }

      // The wizard treats each run as a complete declaration of which
      // features should be enabled. Anything the admin didn't tick on the
      // landing page gets its `.enabled` flag explicitly set to false here,
      // so re-running the wizard is the supported way to turn things off.
      // Without this, unchecked features would silently retain their
      // pre-existing enabled state.
      // Values this attempt adds on its own go into its batch only (#1622):
      // the off switch for every unticked feature, and the dependents a
      // confirmed cascade turns off. They are never saved into the wizard
      // session, so an attempt that fails leaves the admin's choices as they
      // were and Review plans the cascade again from what is on at that time.
      const derived: Record<string, unknown> = {};
      for (const gate of wizardOffGates(state.selectedFeatures)) {
        derived[gate] = false;
      }

      // A closed request abandons any apply that still waits for a lock (the
      // role lock or the channel lock), as the Settings save does: queued work
      // never runs after the browser left. One that has started is not cut off.
      const gone = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) gone.abort();
      };
      res.once("close", onClose);
      if (res.destroyed) onClose();

      const confirmFailure = (text: string, keep = ""): void => {
        const msg = flashKeepingTail(text, keep);
        const qs = new globalThis.URLSearchParams({
          step: "confirm",
          flash: "err",
          msg,
          sig: signFlash("err", msg),
        }).toString();
        res.redirect(303, `/admin/wizard?${qs}`);
      };

      // The Administrator check (#1617), read from Discord again before anything
      // is written. A bot that is known to lack it needs the admin's explicit
      // choice (the Review switch); a check that cannot be made blocks nothing.
      const adminNow = await checkBotAdministrator(client, session.guildId, {
        refresh: true,
      });
      if (
        adminNow.state === "missing" &&
        (req.body as Record<string, unknown> | undefined)?.[
          ADMIN_CONTINUE_FIELD
        ] !== "1"
      ) {
        await recordAudit(session, {
          action: "wizard.apply",
          details: { stage: "administrator" },
          result: "failure",
          errorMessage: "The bot does not have Administrator",
        });
        confirmFailure(
          "Nothing was applied. The bot does not have Administrator. Give it Administrator and choose Check again, or switch on Continue without Administrator, then apply again.",
        );
        return;
      }

      // Feature dependencies (#663, #1622), judged on the batch Review showed
      // (the chosen settings plus the gates for every unticked feature) and
      // before anything is written. A feature being turned off while a part
      // that needs it stays on is applied only when the admin confirmed the
      // extra turn-offs on Review; anything else is refused back to Review,
      // with the wizard session and every choice kept.
      let cascadeOff: string[] = [];
      try {
        const config = ConfigService.getInstance();
        const plan = await planWizardDependencies(
          state.configuration,
          state.selectedFeatures,
          (key) => config.getBooleanStrict(key, false),
        );
        const posted = (req.body as Record<string, unknown> | undefined)
          ?.cascadeOff;
        if (plan.cascadeKeys.length > 0) {
          if (posted !== plan.fingerprint) {
            await recordAudit(session, {
              action: "wizard.apply",
              details: {
                stage: "dependencies",
                cascadeKeys: plan.cascadeKeys,
                reason: posted === undefined ? "not-confirmed" : "out-of-date",
              },
              result: "failure",
              errorMessage:
                "A feature being turned off still has parts that need it",
            });
            confirmFailure(
              posted === undefined
                ? "Nothing was applied. Some parts need a feature you are turning off. Switch on the line that turns them off too, then apply again."
                : "Nothing was applied. The parts that need a feature you are turning off changed since you opened Review. Look at the updated list and apply again.",
            );
            return;
          }
          cascadeOff = plan.cascadeKeys;
        }
        if (plan.blockers.length > 0) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: {
              stage: "dependencies",
              keys: plan.blockers.map((b) => b.key),
            },
            result: "failure",
            errorMessage: plan.blockers.map((b) => b.message).join(" "),
          });
          confirmFailure(
            `Nothing was applied. ${plan.blockers.map((b) => b.message).join(" ")}`,
          );
          return;
        }
      } catch (err) {
        logger.error("Wizard apply: dependencies could not be checked", err);
        await recordAudit(session, {
          action: "wizard.apply",
          details: { stage: "dependencies" },
          result: "failure",
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        });
        confirmFailure(
          "Nothing was applied: the settings could not be checked against each other. Try again in a moment.",
        );
        return;
      }
      for (const key of cascadeOff) derived[key] = false;

      // The channels the steps plan to create (#1662): the plan Review showed
      // must still be the plan, checked before anything is written, so a
      // refusal leaves the server and the settings as they were. Apply
      // creates them later, inside the shared lock, which checks the same plan
      // id again against the server as it is then.
      const plannedChannels = activeWizardCreations(
        state,
        WIZARD_FEATURE_SETTINGS,
      );
      const channelPlanId = String(
        (req.body as Record<string, unknown> | undefined)?.channelPlanId ?? "",
      );
      if (Object.keys(plannedChannels).length > 0) {
        const review = await reviewWizardCreations(
          client,
          session.guildId,
          plannedChannels,
        ).catch((err: unknown): WizardCreateReview => {
          logger.warn("wizard: apply could not plan the channels", err);
          return {
            creations: [],
            rows: [],
            planId: null,
            problems: [
              "Discord could not be read, so the channels can't be checked.",
            ],
          };
        });
        const refusal =
          review.problems.length > 0
            ? review.problems.join(" ")
            : review.planId !== channelPlanId
              ? "The channels on the server changed since you opened Review. Look at the updated list and apply again."
              : null;
        if (refusal) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: {
              stage: "channels",
              keys: Object.keys(plannedChannels),
            },
            result: "failure",
            errorMessage: refusal,
          });
          confirmFailure(`Nothing was applied. ${refusal}`);
          return;
        }
      }

      // Role access (#1321) goes first: it is the part that can be undone, so
      // a failure further on can put it back. It is checked against the live
      // server again, and nothing is written if any check fails.
      let accessUndo: AccessUndo[] = [];
      let accessGuildId = session.guildId;
      let accessApplied: AccessChange[] = [];
      // The roles the Access step creates (#1618) are made first, because the
      // role groups map their ids; `undoRoles` removes them again.
      const plannedRoles = state.access ? (state.roleCreations ?? []) : [];
      let rolesMade: Extract<WizardRoleApply, { ok: true }> | null = null;
      // What a failed apply left behind, for `fitRecovery`.
      let leftGroups: string[] = [];
      let leftRoles: string[] = [];
      let leftChannels: string[] = [];
      const leftover = (): {
        groups: string[];
        roles: string[];
        channels: string[];
      } => ({ groups: leftGroups, roles: leftRoles, channels: leftChannels });
      // What became of the roles this apply created, decided once however many
      // failure paths ask. Decided from a fresh read inside the role lock.
      let roleBack: Promise<{ note: string; leftover: boolean }> | null = null;
      function roleCleanup(): Promise<{ note: string; leftover: boolean }> {
        const made = rolesMade;
        if (!made) return Promise.resolve({ note: "", leftover: false });
        roleBack ??= (async (): Promise<{
          note: string;
          leftover: boolean;
        }> => {
          const back = await made.cleanup();
          if (back.kept.length > 0 || back.stuck.length > 0) {
            logger.warn("wizard: roles left after a failed apply", {
              kept: back.kept,
              stuck: back.stuck,
            });
          }
          const many = (n: number): boolean => n !== 1;
          leftRoles = [...back.kept, ...back.stuck];
          const note = [
            back.removed.length > 0
              ? ` The ${many(back.removed.length) ? "roles" : "role"} created for this apply ${many(back.removed.length) ? "were" : "was"} removed again.`
              : "",
            back.kept.length > 0
              ? ` Kept, because a role group or a saved setting points at ${many(back.kept.length) ? "them" : "it"}: ${idList(back.kept)}.`
              : "",
            back.stuck.length > 0
              ? ` May still exist (not removed or checked): ${idList(back.stuck)}. Check them in Discord before applying again.`
              : "",
          ].join("");
          return {
            note,
            leftover: back.kept.length > 0 || back.stuck.length > 0,
          };
        })();
        return roleBack;
      }
      const undoRoles = async (): Promise<string> => (await roleCleanup()).note;
      if (state.access) {
        let ctx: AccessContext;
        try {
          ctx = await readAccess(session);
        } catch (err) {
          const text = err instanceof Error ? err.message : "Unknown error";
          logger.error("Wizard apply: server could not be read", err);
          await recordAudit(session, {
            action: "wizard.apply",
            details: {
              stage: "access",
              keys: Object.keys(state.configuration),
            },
            result: "failure",
            errorMessage: `Discord or the role groups could not be read: ${text}`,
          });
          confirmFailure(
            "Nothing was applied: Discord or the role groups could not be read. Try again in a moment.",
          );
          return;
        }
        accessGuildId = ctx.guildId;
        const problem = validateSelection(ctx, state.access);
        if (problem) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: {
              stage: "access",
              keys: Object.keys(state.configuration),
            },
            result: "failure",
            errorMessage: problem,
          });
          confirmFailure(
            `Nothing was applied. ${problem} Go back to Access and fix it.`,
          );
          return;
        }
        const changes = diffAccess(
          ctx.groups,
          contextWithNew(ctx, plannedRoles).roles,
          selectionWithNew(state.access, plannedRoles),
        );
        // Apply only what Review showed. If the groups changed since (another
        // admin edited one), the recomputed changes differ: stop and re-review.
        const shown = (req.body as Record<string, unknown> | undefined)
          ?.accessFingerprint;
        if (shown !== accessFingerprint(changes)) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: { stage: "access", reason: "review-out-of-date" },
            result: "failure",
            errorMessage: "The role groups changed since Review",
          });
          confirmFailure(
            "Nothing was applied: the role groups changed since you opened Review. Look at the updated list and apply again.",
          );
          return;
        }
        // The roles to create (#1618): the plan Review showed must still be
        // the plan, checked before the first write so a refusal leaves
        // everything as it was. The permission is checked again inside.
        if (plannedRoles.length > 0) {
          const posted = (req.body as Record<string, unknown> | undefined)
            ?.rolePlanId;
          const review = await reviewWizardRoles(
            client,
            session.guildId,
            ctx,
            plannedRoles,
          ).catch((err: unknown): WizardRoleReview => {
            logger.warn("wizard: apply could not plan the roles", err);
            return {
              roles: [],
              planId: null,
              problems: [
                "Discord could not be read, so the roles can't be checked.",
              ],
            };
          });
          const refusal =
            review.problems.length > 0
              ? review.problems.join(" ")
              : posted !== review.planId
                ? "The roles on the server changed since you opened Review. Look at the updated list and apply again."
                : null;
          if (refusal) {
            await recordAudit(session, {
              action: "wizard.apply",
              details: {
                stage: "roles",
                names: plannedRoles.map((r) => r.name),
              },
              result: "failure",
              errorMessage: refusal,
            });
            confirmFailure(`Nothing was applied. ${refusal}`);
            return;
          }
        }
        // From here on writes are made. The role creation comes first; the
        // groups are then diffed again with the real ids standing where the
        // placeholders were, from a re-read made after the creation (which is
        // checked against the Review fingerprint again).
        let writeCtx = ctx;
        let writeChanges = changes;
        if (plannedRoles.length > 0) {
          const made = await applyWizardRoles(
            client,
            session.guildId,
            session.discordUserId,
            plannedRoles,
            String(
              (req.body as Record<string, unknown> | undefined)?.rolePlanId ??
                "",
            ),
            gone.signal,
          );
          if (!made.ok) {
            await recordAudit(session, {
              action: "wizard.apply",
              details: {
                stage: "roles",
                names: plannedRoles.map((r) => r.name),
              },
              result: "failure",
              errorMessage: made.error,
            });
            const stuck = made.stuck ?? [];
            const keptRoles = made.kept ?? [];
            const removed = made.removed ?? [];
            leftRoles = [...keptRoles, ...stuck];
            const outcome = [
              removed.length > 0
                ? ` The ${removed.length === 1 ? "role" : "roles"} created for this apply ${removed.length === 1 ? "was" : "were"} removed again.`
                : "",
              keptRoles.length > 0
                ? ` Kept, because a role group or a saved setting points at ${keptRoles.length === 1 ? "it" : "them"}: ${idList(keptRoles)}.`
                : "",
              stuck.length > 0
                ? ` May still exist (not removed or checked): ${idList(stuck)}. Check them in Discord before applying again.`
                : "",
            ].join("");
            // A refusal (no create was tried) changed nothing; a failed create
            // may have left a role, so it does not say that.
            confirmFailure(
              `${made.cause ? "The settings were not applied." : "Nothing was applied."} ${made.cause ?? made.error}`,
              fitRecovery(outcome, leftover()),
            );
            return;
          }
          rolesMade = made;
          // The role groups and the roles were read before the lock wait and
          // the Discord requests. Read them again NOW, check the same things
          // and compare the fingerprint Review showed, so a change made
          // meanwhile (a capability another admin set, an admin promotion) is
          // never overwritten, and a rollback never restores stale values.
          const madeIds = new Set(made.created.map((c) => c.id));
          let fresh: AccessContext | null = null;
          // Every role as the fresh read has it, created ones included, with
          // their CURRENT positions: the ranking of the new groups uses these,
          // not the positions in the create responses.
          let freshRoles: AccessContext["roles"] = [];
          let staleWhy: string | null = null;
          try {
            const again = await readAccess(session);
            freshRoles = again.roles;
            fresh = {
              ...again,
              roles: again.roles.filter((r) => !madeIds.has(r.id)),
            };
            // The picks as they stand, then the FULL mapping (placeholders
            // swapped for the real ids) against the unfiltered fresh read: a
            // created role that was deleted, moved above the bot, or is now
            // refused for any other reason must not be mapped.
            const finalSelection = swapPlaceholders(
              selectionWithNew(state.access, plannedRoles),
              new Map(made.created.map((c) => [c.placeholder, c.id])),
            );
            // Any group that already points at a role created for this apply
            // (another admin linked it meanwhile), whatever its name or
            // capabilities: the diff ignores a group with no access scope, and
            // would UPDATE it instead of creating the reviewed group.
            const linked = again.groups.some(
              (g) => g.roleId !== null && madeIds.has(g.roleId),
            );
            const problemNow = linked
              ? "The role groups changed since you opened Review. Look at the updated list and apply again."
              : (validateSelection(fresh, state.access) ??
                validateSelection(again, finalSelection));
            const fingerprintNow = accessFingerprint(
              diffAccess(
                fresh.groups,
                contextWithNew(fresh, plannedRoles).roles,
                selectionWithNew(state.access, plannedRoles),
              ),
            );
            if (problemNow) staleWhy = problemNow;
            else if (fingerprintNow !== shown) {
              staleWhy =
                "The role groups changed since you opened Review. Look at the updated list and apply again.";
            }
          } catch (err) {
            logger.warn("wizard: apply could not re-read the access", err);
            staleWhy =
              "Discord or the role groups could not be read again, so nothing was written.";
          }
          if (staleWhy || !fresh) {
            await recordAudit(session, {
              action: "wizard.apply",
              details: { stage: "access", reason: "changed-during-roles" },
              result: "failure",
              errorMessage: staleWhy ?? "unreadable",
            });
            const note = await undoRoles();
            confirmFailure(
              `The settings were not applied. ${staleWhy}`,
              fitRecovery(note, leftover()),
            );
            return;
          }
          const writeBase = fresh;
          const byPlaceholder = new Map(
            made.created.map((c) => [c.placeholder, c.id]),
          );
          writeCtx = {
            ...writeBase,
            roles: freshRoles,
          };
          writeChanges = diffAccess(
            writeBase.groups,
            writeCtx.roles,
            swapPlaceholders(
              selectionWithNew(state.access, plannedRoles),
              byPlaceholder,
            ),
          );
        }
        if (writeChanges.length > 0) {
          const written = await applyAccessChanges(
            accessDeps(session),
            writeCtx,
            writeChanges,
          );
          if (!written.ok) {
            await recordAudit(session, {
              action: "wizard.apply",
              details: {
                stage: "access",
                rolledBack: written.rolledBack,
                stuck: written.stuck,
              },
              result: "failure",
              errorMessage: written.error,
            });
            // The roles this apply created go too (a role a stuck group still
            // points at is kept and reported). Only the cause is shortened.
            leftGroups = written.stuck;
            const roleNote = await undoRoles();
            // With roles made, "nothing was applied" may not be true (a role
            // can be kept or stuck), so that head is only for no roles.
            confirmFailure(
              rolesMade
                ? `The settings were not applied. ${written.error}`
                : written.stuck.length > 0
                  ? `Nothing else was applied. ${written.error}`
                  : `Nothing was applied. ${written.error}`,
              fitRecovery(
                `${
                  written.stuck.length > 0
                    ? ` These could not be undone and are live: ${idList(written.stuck)}. Check Role groups.`
                    : ` ${
                        written.rolledBack > 0
                          ? "The role groups written before it were undone."
                          : "No role group was written."
                      }`
                }${roleNote}`,
                leftover(),
              ),
            );
            return;
          }
          accessUndo = written.undo;
          accessApplied = written.applied;
        }
      }
      const undoAccess = async (): Promise<string> => {
        if (accessUndo.length === 0) return "";
        const back = await rollbackAccess(
          accessDeps(session),
          accessGuildId,
          accessUndo,
        );
        if (back.stuck.length > 0) {
          leftGroups = back.stuck;
          logger.warn("wizard: role groups left after a failed apply", {
            stuck: back.stuck,
          });
        }
        return back.stuck.length > 0
          ? ` The role mapping could not be fully undone and is live for: ${idList(back.stuck)}. Check Role groups.`
          : " The role mapping was undone too.";
      };
      // The mapping first, then the roles it pointed at.
      const undoAll = async (): Promise<string> =>
        (await undoAccess()) + (await undoRoles());

      // The channels are created after the role access (which can be undone)
      // and before the settings that point at them. One call makes them all and
      // removes what it made if one of them fails. When anything after it
      // fails, `undoChannels` decides per channel from a fresh read of the
      // stored settings: one that a saved setting points at is kept and
      // reported, the rest are removed (and any left over are named).
      let createdChannels: CreatedForSetting[] = [];
      let channelCleanup = async (): Promise<{
        note: string;
        leftover: boolean;
      }> => ({ note: "", leftover: false });
      if (Object.keys(plannedChannels).length > 0) {
        const made = await applyWizardCreations(
          client,
          session.guildId,
          session.discordUserId,
          plannedChannels,
          channelPlanId,
          gone.signal,
        );
        if (!made.ok) {
          await recordAudit(session, {
            action: "wizard.apply",
            details: {
              stage: "channels",
              keys: Object.keys(plannedChannels),
            },
            result: "failure",
            errorMessage: made.error,
          });
          // "Nothing was applied" would not be true when a channel could not
          // be removed again, so the outcome is worded here from the helper's
          // structured result. Only the cause (which can be long) is shortened
          // to fit the flash; the outcome sentence, the first ids and the
          // recovery instruction are kept whole.
          const stuck = made.stuck ?? [];
          const removed = made.removed ?? [];
          if (stuck.length > 0 || removed.length > 0) {
            logger.warn("wizard: channels after a failed create", {
              removed,
              stuck,
            });
          }
          const outcome =
            stuck.length > 0
              ? ` May still exist (not removed or checked): ${idList(stuck)}. Check them in Discord before applying again.`
              : removed.length > 0
                ? ` The ${removed.length === 1 ? "channel or category" : "channels or categories"} created for this apply ${removed.length === 1 ? "was" : "were"} removed again.`
                : "";
          leftChannels = stuck;
          const undone = await undoAll();
          confirmFailure(
            `The settings were not applied. ${made.cause ?? made.error}`,
            fitRecovery(`${outcome}${undone}`, leftover()),
          );
          return;
        }
        createdChannels = made.channels;
        for (const c of made.channels) derived[c.key] = c.id;
        channelCleanup = async (): Promise<{
          note: string;
          leftover: boolean;
        }> => {
          const back = await made.cleanup();
          if (back.kept.length > 0 || back.stuck.length > 0) {
            logger.warn("wizard: channels left after a failed apply", {
              kept: back.kept,
              stuck: back.stuck,
            });
          }
          leftChannels = [...back.kept, ...back.stuck];
          const list = idList;
          const note = [
            back.removed.length > 0
              ? ` The ${back.removed.length === 1 ? "channel or category" : "channels or categories"} created for this apply ${back.removed.length === 1 ? "was" : "were"} removed again.`
              : "",
            back.kept.length > 0
              ? ` Kept, because a saved setting points at ${back.kept.length === 1 ? "it" : "them"}: ${list(back.kept)}.`
              : "",
            back.stuck.length > 0
              ? ` May still exist (not removed or checked): ${list(back.stuck)}. Check them in Discord before applying again.`
              : "",
          ].join("");
          return {
            note,
            leftover: back.kept.length > 0 || back.stuck.length > 0,
          };
        };
      }

      const pendingKeys = [
        ...new Set([
          ...Object.keys(state.configuration),
          ...Object.keys(derived),
        ]),
      ];
      try {
        const result = await wizard.applyConfiguration(
          session.discordUserId,
          session.guildId,
          derived,
          state.configuration,
        );
        await recordAudit(session, {
          action: "wizard.apply",
          details: {
            keys: pendingKeys,
            count: pendingKeys.length,
            appliedKeys: result.appliedKeys,
            failedKey: result.failedKey ?? null,
            rolledBackKeys: result.rolledBackKeys,
            revertFailedKeys: result.revertFailedKeys,
            reloadFailed: result.reloadFailed ?? false,
            cascadeOff,
            accessGroups: accessApplied.map((c) => c.groupId ?? c.groupName),
            ...(createdChannels.length > 0
              ? { channels: createdChannels }
              : {}),
            ...(rolesMade
              ? {
                  roles: rolesMade.created.map((c) => ({
                    id: c.id,
                    name: c.name,
                  })),
                }
              : {}),
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success
            ? null
            : (result.errorMessage ?? "applyConfiguration failed"),
        });
        if (result.success) {
          wizard.endSession(session.discordUserId, session.guildId);
          const madeIds = (kind: "text" | "category"): number =>
            new Set(
              createdChannels
                .filter((c) => c.created && c.kind === kind)
                .map((c) => c.id),
            ).size;
          const madeCount = madeIds("text");
          const madeCategories = madeIds("category");
          const roleCount = rolesMade?.created.length ?? 0;
          const madeParts = [
            roleCount > 0
              ? `${roleCount} role${roleCount === 1 ? "" : "s"}`
              : "",
            madeCount > 0
              ? `${madeCount} channel${madeCount === 1 ? "" : "s"}`
              : "",
            madeCategories > 0
              ? `${madeCategories} ${madeCategories === 1 ? "category" : "categories"}`
              : "",
          ].filter(Boolean);
          const summary = `Wizard applied ${pendingKeys.length} setting${pendingKeys.length === 1 ? "" : "s"}${
            accessApplied.length > 0
              ? ` and ${accessApplied.length} role group change${accessApplied.length === 1 ? "" : "s"}`
              : ""
          }${madeParts.length > 0 ? ` and created ${madeParts.join(" and ")}` : ""}`;
          flashRedirect(res, "/admin/wizard/done", {
            type: "ok",
            text: `${summary}.`,
          });
          return;
        }
        // The apply failed. Tell the operator exactly what state the config
        // is in (#780) — which write failed, what was rolled back, and which
        // keys (if any) could not be reverted and are therefore live — and
        // keep the session so they can retry from the confirm step instead
        // of losing their input.
        // The channels go back unless a saved setting points at them (a
        // rollback or a reload that did not finish): decided per channel.
        const channelBack = await channelCleanup();
        // The mapping goes back first, then the roles it pointed at.
        const accessNote = await undoAccess();
        const rolesBack = await roleCleanup();
        // The usual message ends "No changes were applied. You can retry.",
        // which is not true while a created channel or role still exists.
        const base =
          (channelBack.leftover || rolesBack.leftover) &&
          result.revertFailedKeys.length === 0 &&
          !result.reloadFailed
            ? `Wizard apply failed: ${wizardApplyFailureReason(result)}. The settings were not saved.`
            : wizardApplyFailureMessage(result);
        // The underlying error is the part that may be shortened; the
        // channels' outcome and the role mapping's are kept whole.
        const failureMsg = flashKeepingTail(
          base,
          fitRecovery(
            channelBack.note + accessNote + rolesBack.note,
            leftover(),
          ),
        );
        const qs = new globalThis.URLSearchParams({
          step: "confirm",
          flash: "err",
          msg: failureMsg,
          sig: signFlash("err", failureMsg),
        }).toString();
        res.redirect(303, `/admin/wizard?${qs}`);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Wizard apply failed", err);
        const accessNote = await undoAll();
        // A throw after the engine returned (the audit write) leaves the
        // settings stored: the cleanup keeps every channel a stored setting
        // points at, so only a throw before the first write removes them.
        const channelNote = (await channelCleanup()).note;
        await recordAudit(session, {
          action: "wizard.apply",
          details: { keys: pendingKeys },
          result: "failure",
          errorMessage: text,
        });
        // The session and the admin's choices stay, like every other refused
        // apply: they go back to Review with the reason and can retry.
        confirmFailure(
          `The settings could not be applied. ${text}`,
          fitRecovery(`${channelNote}${accessNote}`, leftover()),
        );
      }
    }),
  );

  router.post(
    "/wizard/cancel",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(session.discordUserId, session.guildId);
      const discardedKeys = state ? Object.keys(state.configuration) : [];
      wizard.endSession(session.discordUserId, session.guildId);
      await recordAudit(session, {
        action: "wizard.cancel",
        details: { discardedKeys, hadSession: state !== null },
        result: "success",
      });
      flashRedirect(res, "/admin/", {
        type: "ok",
        text: "Wizard cancelled. No changes were applied.",
      });
    }),
  );

  return router;
}
