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
import {
  defaultConfig,
  settingsMetadata,
  getDependencies,
  isEnabledValue,
} from "../../../services/config-schema.js";
import { FLASH_MAX } from "../../http-flash.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import {
  renderWizardPage,
  renderWizardStepPage,
  renderWizardConfirmPage,
  settingValueFieldName,
} from "../../admin-views.js";
import { fetchChannelData, fetchRoleData } from "../../read-only-routes.js";
import {
  flashRedirect,
  requireSessionContext,
  asyncHandler,
  getCsrfFromReq,
  navStatusForPage,
  WIZARD_FEATURE_SETTINGS,
  WIZARD_FEATURE_ORDER,
  wizardApplyFailureMessage,
  coerceConfigValue,
  truncateFlash,
} from "./helpers.js";

export function createWizardRouter(client: Client): Router {
  const router = Router();

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
      const flashType = String(req.query.flash ?? "");
      const flashMsg = String(req.query.msg ?? "");
      const flash =
        flashMsg &&
        (flashType === "ok" || flashType === "warn" || flashType === "err")
          ? { type: flashType as "ok" | "warn" | "err", text: flashMsg }
          : null;

      if (existing && Number(req.query.reset) !== 1) {
        const features = existing.selectedFeatures;
        const stepParam = req.query.step;

        if (typeof stepParam === "string" && stepParam === "confirm") {
          const pending = Object.entries(existing.configuration);
          res.type("text/html").send(
            renderWizardConfirmPage({
              csrfToken,
              remainingMs,
              navFeatureStatus,
              pending,
              metadata: settingsMetadata,
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

          // Resolve a key's effective current value: prefer what the admin
          // already entered earlier in this wizard run, then the persisted
          // config, then the schema default. Used for both the visible fields
          // and the cross-feature dependency targets below.
          const resolveCurrent = async (k: string): Promise<unknown> => {
            const fromWizard = wizard.getConfiguration(
              session.discordUserId,
              session.guildId,
              k,
            );
            if (fromWizard !== undefined) return fromWizard;
            try {
              return await config.get(k);
            } catch {
              return defaultConfig[k as keyof typeof defaultConfig];
            }
          };

          const currentValues: Record<string, unknown> = {};
          for (const k of settingKeys) {
            currentValues[k] = await resolveCurrent(k);
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
              enabledByKey[dep] = isEnabledValue(await resolveCurrent(dep));
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
          res.type("text/html").send(
            renderWizardStepPage({
              csrfToken,
              remainingMs,
              navFeatureStatus,
              stepIndex: step,
              totalSteps: features.length,
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
      for (const k of settingKeys) {
        if (masterOff && k !== masterKey) continue;
        const raw = body?.[settingValueFieldName(k)];
        const coerced = coerceConfigValue(k, raw);
        if (coerced.ok) {
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

      // The wizard treats each run as a complete declaration of which
      // features should be enabled. Anything the admin didn't tick on the
      // landing page gets its `.enabled` flag explicitly set to false here,
      // so re-running the wizard is the supported way to turn things off.
      // Without this, unchecked features would silently retain their
      // pre-existing enabled state.
      const selectedSet = new Set(state.selectedFeatures);
      for (const fk of WIZARD_FEATURE_ORDER) {
        if (selectedSet.has(fk)) continue;
        const enabledKey = (WIZARD_FEATURE_SETTINGS[fk] ?? []).find((k) =>
          k.endsWith(".enabled"),
        );
        if (!enabledKey) continue;
        wizard.addConfiguration(
          session.discordUserId,
          session.guildId,
          enabledKey,
          false,
        );
      }

      const pendingKeys = Object.keys(state.configuration);
      try {
        const result = await wizard.applyConfiguration(
          session.discordUserId,
          session.guildId,
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
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success
            ? null
            : (result.errorMessage ?? "applyConfiguration failed"),
        });
        if (result.success) {
          wizard.endSession(session.discordUserId, session.guildId);
          flashRedirect(res, "/admin/settings", {
            type: "ok",
            text: `Wizard applied ${pendingKeys.length} setting${pendingKeys.length === 1 ? "" : "s"}.`,
          });
          return;
        }
        // The apply failed. Tell the operator exactly what state the config
        // is in (#780) — which write failed, what was rolled back, and which
        // keys (if any) could not be reverted and are therefore live — and
        // keep the session so they can retry from the confirm step instead
        // of losing their input.
        const qs = new globalThis.URLSearchParams({
          step: "confirm",
          flash: "err",
          msg: truncateFlash(wizardApplyFailureMessage(result)),
        }).toString();
        res.redirect(303, `/admin/wizard?${qs}`);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Wizard apply failed", err);
        await recordAudit(session, {
          action: "wizard.apply",
          details: { keys: pendingKeys },
          result: "failure",
          errorMessage: text,
        });
        wizard.endSession(session.discordUserId, session.guildId);
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Wizard failed: ${text}`,
        });
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
