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
import { WizardService } from "../../../services/wizard-service.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import { planRoleGroups } from "../../../services/role-group-adoption.js";
import { ServerAdoptionService } from "../../../services/server-adoption-service.js";
import {
  hostCreateState,
  reviewHostRole,
  startHostRole,
  type HostReview,
  type HostRoleResult,
} from "../../../services/wizard-host-role.js";
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
import { renderWizardAccessPage } from "../../wizard-access-view.js";
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
import { canBotCreate } from "../../../services/bot-create-check.js";
import { offersCreateChannel } from "../../setting-create.js";
import { loadCreateChannelAnswer } from "../../setting-create-load.js";
import {
  parsePickerCreateValue,
  pickerCreateValue,
} from "../../setting-pickers.js";
import {
  activeWizardCreations,
  applyWizardCreations,
  reviewWizardCreations,
  type CreatedForSetting,
  type WizardCreateReview,
} from "../../wizard-create.js";

/** A role id as Discord sends it: digits only. Anything else is ignored. */
const SNOWFLAKE = /^\d{1,25}$/;

function pickedRoles(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return [...new Set(list.map(String).filter((id) => SNOWFLAKE.test(id)))];
}

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

/** An Event host role job id as the engine makes it; anything else is ignored. */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The wizard's features named in a query value (comma separated), in a form the page can tick again. */
function tickedFeatures(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [
    ...new Set(raw.split(",").filter((f) => WIZARD_FEATURE_ORDER.includes(f))),
  ];
}

/** Features whose scope the Access step can leave without anybody to run it. */
const GAP_FEATURES = ["events", "moderation"] as const;

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

  /** The plan for creating the Event host role, previewed with nothing written. */
  async function previewHostRole(
    session: { guildId: string; discordUserId: string },
    ctx: AccessContext,
    changes: readonly AccessChange[],
  ): Promise<HostReview> {
    const guild = await client.guilds.fetch(session.guildId);
    return reviewHostRole(guild, session.discordUserId, ctx, changes);
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
          const selection =
            existing.access ??
            (ctx ? currentMapping(ctx.groups) : emptySelection());
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
                    selection,
                    existing.createHost
                      ? new Set(["host"] as const)
                      : undefined,
                  )
                : [],
              hostCreate: ctx ? hostCreateState(ctx) : null,
              createHost: existing.createHost === true,
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
          let hostRole: HostReview | null = null;
          if (existing.access) {
            try {
              const ctx = await readAccess(session);
              accessProblem = validateSelection(ctx, existing.access);
              accessChanges = diffAccess(
                ctx.groups,
                ctx.roles,
                existing.access,
              );
              fingerprint = accessFingerprint(accessChanges);
              gaps = accessGaps(
                await enabledGapFeatures(existing),
                existing.access,
                existing.createHost ? new Set(["host"] as const) : undefined,
              );
              if (existing.createHost) {
                hostRole = await previewHostRole(session, ctx, accessChanges);
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
              hostRole,
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

          const currentValues: Record<string, unknown> = {};
          for (const k of settingKeys) {
            currentValues[k] = resolveCurrent(k);
            // A channel planned on an earlier visit is drawn again as the
            // pending option; without the row (permissions unreadable) the
            // step shows the stored value and the admin chooses again.
            const planned = existing.creations?.[k];
            if (planned && pickerCreate && offersCreateChannel(k)) {
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
      const job = req.query.job;
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
          hostJobId: typeof job === "string" && JOB_ID.test(job) ? job : null,
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
      const selection: AccessSelection = normaliseSelection({
        admin: pickedRoles(body["roles_admin"]),
        staff: pickedRoles(body["roles_staff"]),
        host: pickedRoles(body["roles_host"]),
      });
      const createHost = body["create_host"] === "1";
      const stay = (text: string): void => {
        res.redirect(
          303,
          `/admin/wizard?step=access&${flashRedirectQuery({ type: "warn", text })}`,
        );
      };
      let problem: string | null;
      try {
        const ctx = await readAccess(session);
        problem =
          validateSelection(ctx, selection) ??
          pendingConfigOverlap(state.configuration, selection);
        if (!problem && createHost) {
          const offer = hostCreateState(ctx);
          if (!offer.available) {
            problem = offer.message;
          } else if (selection.host.length > 0) {
            problem =
              "Pick existing Event host roles or create a new one, not both.";
          }
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
        createHost,
      );
      await recordAudit(session, {
        action: "wizard.access",
        details: {
          selection,
          createHost,
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
      let createAnswer: Awaited<ReturnType<typeof canBotCreate>> | null = null;
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
        if (offersCreateChannel(k) && typeof posted === "string") {
          const named = parsePickerCreateValue(posted);
          if (named) {
            if (!named.ok) {
              dropped.push({ key: k, reason: named.error });
              continue;
            }
            createAnswer ??= await canBotCreate(client, session.guildId, {
              kind: "channel",
            });
            if (createAnswer.ok !== true) {
              dropped.push({
                key: k,
                reason:
                  createAnswer.ok === false
                    ? createAnswer.reason
                    : "KoolBot could not check whether it may create channels. Try again.",
              });
              continue;
            }
            wizard.setCreation(session.discordUserId, session.guildId, k, {
              name: named.name,
              kind: "text",
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
      const state = wizard.getSession(session.discordUserId, session.guildId);
      if (!state) {
        flashRedirect(res, "/admin/wizard", {
          type: "warn",
          text: "Wizard session expired. Please start again.",
        });
        return;
      }

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

      const confirmFailure = (text: string): void => {
        const msg = truncateFlash(text);
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
        const changes = diffAccess(ctx.groups, ctx.roles, state.access);
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
        // The Event host role (#1365): the plan Review showed must still be the
        // plan, and it must hold that one role and nothing else. Checked before
        // the first write so a refusal leaves everything as it was.
        if (state.createHost) {
          const posted = (req.body as Record<string, unknown> | undefined)
            ?.hostPlanId;
          let refusal: string | null = null;
          try {
            const host = await previewHostRole(session, ctx, changes);
            if (host.problems.length > 0) {
              refusal = host.problems[0];
            } else if (posted !== host.planId) {
              refusal =
                "the server or the role groups changed since you opened Review. Look at the updated plan and apply again.";
            }
          } catch (err) {
            logger.warn("wizard: host role plan could not be made", err);
            refusal =
              "Discord could not be read, so the Event host role can't be checked.";
          }
          if (refusal) {
            await recordAudit(session, {
              action: "wizard.apply",
              details: { stage: "host-role" },
              result: "failure",
              errorMessage: refusal,
            });
            confirmFailure(`Nothing was applied: ${refusal}`);
            return;
          }
        }
        if (changes.length > 0) {
          const written = await applyAccessChanges(
            accessDeps(session),
            ctx,
            changes,
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
            confirmFailure(
              written.stuck.length > 0
                ? `Nothing else was applied. ${written.error} These could not be undone and are live: ${written.stuck.join(", ")}. Check Role groups.`
                : `Nothing was applied. ${written.error} ${
                    written.rolledBack > 0
                      ? "The role groups written before it were undone."
                      : "No role group was written."
                  }`,
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
        return back.stuck.length > 0
          ? ` The role mapping could not be fully undone and is live for: ${back.stuck.join(", ")}. Check Role groups.`
          : " The role mapping was undone too.";
      };

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
        // A closed request abandons the apply while it still waits for the
        // lock (another channel write is running), as the Settings save does:
        // queued work never runs after the browser left.
        const gone = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) gone.abort();
        };
        res.once("close", onClose);
        if (res.destroyed) onClose();
        const made = await applyWizardCreations(
          client,
          session.guildId,
          session.discordUserId,
          plannedChannels,
          channelPlanId,
          gone.signal,
        );
        res.off("close", onClose);
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
          // The helper says what happened to the channels; "nothing was
          // applied" would not be true when one could not be removed again.
          confirmFailure(
            `The settings were not applied. ${made.error}${await undoAccess()}`,
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
          const list = (ids: string[]): string => ids.join(", ");
          const note = [
            back.removed.length > 0
              ? ` The ${back.removed.length === 1 ? "channel" : "channels"} created for this apply ${back.removed.length === 1 ? "was" : "were"} removed again.`
              : "",
            back.kept.length > 0
              ? ` Kept, because a saved setting points at ${back.kept.length === 1 ? "it" : "them"}: ${list(back.kept)}.`
              : "",
            back.stuck.length > 0
              ? ` These channels were created for this apply and may still exist (they could not be removed or checked): ${list(back.stuck)}. Check them in Discord before applying again.`
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
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success
            ? null
            : (result.errorMessage ?? "applyConfiguration failed"),
        });
        if (result.success) {
          wizard.endSession(session.discordUserId, session.guildId);
          const madeCount = new Set(
            createdChannels.filter((c) => c.created).map((c) => c.id),
          ).size;
          const summary = `Wizard applied ${pendingKeys.length} setting${pendingKeys.length === 1 ? "" : "s"}${
            accessApplied.length > 0
              ? ` and ${accessApplied.length} role group change${accessApplied.length === 1 ? "" : "s"}`
              : ""
          }${
            madeCount > 0
              ? ` and created ${madeCount} channel${madeCount === 1 ? "" : "s"}`
              : ""
          }`;
          if (state.createHost) {
            // Last, because the engine's job is the one step that can't be
            // taken back inside this request. It reports only that the job
            // started; Role groups shows how it ended.
            const started = await startHostRole(
              {
                groups: RoleGroupService.getInstance(),
                audit: async (entry): Promise<void> => {
                  await recordAudit(session, entry);
                },
                plan: async () =>
                  planRoleGroups(
                    await client.guilds.fetch(session.guildId),
                    session.discordUserId,
                  ),
                start: async (plan) =>
                  (
                    await ServerAdoptionService.getInstance(
                      client,
                      await client.guilds.fetch(session.guildId),
                    )
                  ).startApply(plan, { actor: session }),
              },
              session.guildId,
              String(
                (req.body as Record<string, unknown> | undefined)?.hostPlanId ??
                  "",
              ),
            ).catch((err: unknown): HostRoleResult => ({
              ok: false,
              error: `The Event host role could not be started (${err instanceof Error ? err.message : String(err)}).`,
              groupStuck: false,
            }));
            if (started.ok) {
              res.redirect(
                303,
                `/admin/wizard/done?${flashRedirectQuery({
                  type: "ok",
                  text: `${summary}. The Event host role is being created.`,
                })}&job=${encodeURIComponent(started.jobId)}`,
              );
              return;
            }
            flashRedirect(res, "/admin/role-groups", {
              type: "err",
              text: `${summary}, but the Event host role was not created. ${started.error}${
                started.groupStuck
                  ? " The Event host group could not be removed again; check it here."
                  : " Nothing was left behind for it; add it again with the Event host preset."
              }`,
            });
            return;
          }
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
        // The usual message ends "No changes were applied. You can retry.",
        // which is not true while a created channel still exists.
        const base =
          channelBack.leftover &&
          result.revertFailedKeys.length === 0 &&
          !result.reloadFailed
            ? `Wizard apply failed: ${wizardApplyFailureReason(result)}. The settings were not saved.`
            : wizardApplyFailureMessage(result);
        const failureMsg = truncateFlash(
          base + channelBack.note + (await undoAccess()),
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
        const accessNote = await undoAccess();
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
          `The settings could not be applied. ${text}${channelNote}${accessNote}`,
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
