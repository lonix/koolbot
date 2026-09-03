/**
 * Settings — single-key set/reset, reload, section save and YAML export/import.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import * as yaml from "js-yaml";
import logger from "../../../utils/logger.js";
import { ConfigService } from "../../../services/config-service.js";
import { BotStatusService } from "../../../services/bot-status-service.js";
import { CommandManager } from "../../../services/command-manager.js";
import {
  defaultConfig,
  settingsMetadata,
} from "../../../services/config-schema.js";
import { PROTECTED_KEYS } from "../../bootstrap-vars.js";
import { recordAudit } from "../../audit.js";
import { findUnknownShortcodes } from "../../../utils/emoji-shortcodes.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import {
  renderImportDiffPage,
  settingValueFieldName,
  type ImportDiffRow,
} from "../../admin-views.js";
import {
  flashRedirect,
  respondSectionFlash,
  getString,
  getCheckbox,
  requireSessionContext,
  asyncHandler,
  getCsrfFromReq,
  navStatusForPage,
  safeAdminRedirect,
  EMOJI_NAME_KEYS,
  coerceConfigValue,
  findSectionMasterKey,
  resetConfigToDefaults,
} from "./helpers.js";

export function createSettingsRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Settings — single-key set/reset + reload (issue #383)
  // ============================================================

  router.post(
    "/settings/set",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const key = getString(req, "key");
      const raw = (req.body as Record<string, unknown> | undefined)?.value;
      // Where to land after the write. Defaults to /admin/settings (this
      // route's historical target); the feature pages' inline "Enable"
      // action passes their own page so the operator returns there (#610).
      const redirectTo = safeAdminRedirect(getString(req, "redirect"));

      const coerced = coerceConfigValue(key, raw);
      if (!coerced.ok) {
        await recordAudit(session, {
          action: "setting.set",
          targetId: key || null,
          details: { reason: coerced.reason },
          result: "failure",
          errorMessage: coerced.reason,
        });
        flashRedirect(
          res,
          redirectTo,
          {
            type: "err",
            text: `Cannot set ${key || "(empty key)"}: ${coerced.reason}.`,
          },
          key ? [key] : [],
        );
        return;
      }

      const config = ConfigService.getInstance();
      let before: unknown;
      try {
        before = await config.get(key);
      } catch {
        before = defaultConfig[key as keyof typeof defaultConfig];
      }
      const meta = settingsMetadata[key as keyof typeof settingsMetadata];
      try {
        await config.set(
          key,
          coerced.value,
          meta?.description ?? "",
          meta?.category ?? key.split(".")[0],
        );
        await recordAudit(session, {
          action: "setting.set",
          targetId: key,
          details: { before, after: coerced.value },
          result: "success",
        });
        // For the channel-name keys, surface any `:shortcode:` that wasn't
        // recognised so the admin learns it stayed as literal text rather
        // than silently wondering why their emoji didn't appear (#558). The
        // resolved value is already echoed back in the message above.
        const unknown = EMOJI_NAME_KEYS.has(key)
          ? findUnknownShortcodes(coerced.value)
          : [];
        const hint =
          unknown.length > 0
            ? ` Note: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} recognised emoji shortcode${unknown.length === 1 ? "" : "s"} (kept as typed; custom server emoji can't appear in channel names).`
            : "";
        flashRedirect(res, redirectTo, {
          type: unknown.length > 0 ? "warn" : "ok",
          text: `Set ${key} = ${String(coerced.value)}.${hint}`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Set setting failed", err);
        await recordAudit(session, {
          action: "setting.set",
          targetId: key,
          details: { before, attempted: coerced.value },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(
          res,
          redirectTo,
          { type: "err", text: `Failed to set ${key}: ${text}` },
          [key],
        );
      }
    }),
  );

  router.post(
    "/settings/reset",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const key = getString(req, "key");
      // Feature pages that reuse the settings controls (e.g. Voice Channels,
      // #705) pass their own page so a per-key Reset lands back where it was
      // clicked; allowlisted the same way as /settings/set and save-section.
      const redirectTo = safeAdminRedirect(getString(req, "redirect"));
      if (!(key in defaultConfig)) {
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key || null,
          result: "failure",
          errorMessage: "unknown key",
        });
        flashRedirect(res, redirectTo, {
          type: "err",
          text: `Unknown setting: ${key || "(empty)"}.`,
        });
        return;
      }

      const config = ConfigService.getInstance();
      let before: unknown;
      try {
        before = await config.get(key);
      } catch {
        before = undefined;
      }
      try {
        await config.delete(key);
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key,
          details: {
            before,
            after: defaultConfig[key as keyof typeof defaultConfig],
          },
          result: "success",
        });
        flashRedirect(res, redirectTo, {
          type: "ok",
          text: `Reset ${key} to default.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reset setting failed", err);
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, redirectTo, {
          type: "err",
          text: `Failed to reset ${key}: ${text}`,
        });
      }
    }),
  );

  // Reset every setting to its schema default (issue #487). Two-step
  // confirm: the page guards the click with a JS confirm() and requires the
  // operator to type the guild name (the form field re-validated below).
  router.post(
    "/settings/reset-defaults",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};

      // Defence-in-depth: this endpoint takes no per-key payload, but a
      // crafted request that smuggles a protected bootstrap key (Discord
      // token, Mongo URI, WebUI session config) is refused outright — those
      // keys must never be touched by a settings reset.
      const protectedHit = Object.keys(body).find((k) => PROTECTED_KEYS.has(k));
      if (protectedHit) {
        await recordAudit(session, {
          action: "settings.reset-defaults",
          result: "failure",
          errorMessage: "protected key in payload",
          details: { protectedKey: protectedHit },
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "Reset refused: request contained a protected bootstrap key.",
        });
        return;
      }

      // The operator must type the guild name (falling back to the guild id
      // when Discord can't be reached) to commit. Accept either so a fetch
      // failure between render and submit can't lock the operator out.
      let guildName: string | null = null;
      try {
        const guild = await client.guilds.fetch(session.guildId);
        guildName = guild.name;
      } catch (err) {
        logger.debug("reset-defaults guild fetch failed", err);
      }
      const expected = guildName ?? session.guildId;
      const confirmText = getString(req, "confirm");
      const confirmed =
        confirmText.length > 0 &&
        (confirmText === expected || confirmText === session.guildId);
      if (!confirmed) {
        await recordAudit(session, {
          action: "settings.reset-defaults",
          result: "failure",
          errorMessage: "confirmation text did not match",
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Reset cancelled — type "${expected}" exactly to confirm.`,
        });
        return;
      }

      const config = ConfigService.getInstance();
      try {
        const { updated, deleted, failed } =
          await resetConfigToDefaults(config);
        const landed = updated + deleted;
        // Mirror the YAML-import audit: `result: "failure"` only when nothing
        // landed, otherwise `success` with a `partial` flag for reporting.
        const outcome: "ok" | "partial" | "failed" =
          failed.length === 0 ? "ok" : landed > 0 ? "partial" : "failed";
        await recordAudit(session, {
          action: "settings.reset-defaults",
          details: {
            updated,
            deleted,
            failed,
            failedCount: failed.length,
            outcome,
          },
          result: outcome === "failed" ? "failure" : "success",
          errorMessage:
            failed.length > 0
              ? failed
                  .slice(0, 5)
                  .map((f) => `${f.key}: ${f.reason}`)
                  .join("; ")
              : null,
        });

        const orphanNote =
          deleted > 0
            ? `, ${deleted} orphan key${deleted === 1 ? "" : "s"} removed`
            : "";
        const reloadNote = " You may need to Reload commands.";
        if (failed.length === 0) {
          flashRedirect(res, "/admin/settings", {
            type: "ok",
            text: `Settings reset to defaults — ${updated} key${updated === 1 ? "" : "s"} updated${orphanNote}.${reloadNote}`,
          });
          return;
        }
        flashRedirect(res, "/admin/settings", {
          type: landed > 0 ? "warn" : "err",
          text: `Reset ${landed > 0 ? "partially " : ""}failed — ${updated} key${updated === 1 ? "" : "s"} updated${orphanNote}, ${failed.length} failed (first: ${failed[0].key} — ${failed[0].reason}).${landed > 0 ? reloadNote : ""}`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reset to defaults failed", err);
        await recordAudit(session, {
          action: "settings.reset-defaults",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Reset failed: ${text}`,
        });
      }
    }),
  );

  // Bulk save for a single Settings section (issue #433). Replaces the
  // per-row "Set" button with one "Save" per category, posting every key
  // in the section in a single request. Atomic: if any value fails to
  // coerce, no DB writes happen and the operator gets a flash listing the
  // offending keys. Once coercion passes, the writes are applied
  // sequentially; a write that throws is reported in the flash but
  // earlier writes are not rolled back (ConfigService has no transaction
  // primitive, and partial application matches the YAML-import semantics).
  router.post(
    "/settings/save-section",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const category = getString(req, "category");
      // Where to land after the save. Defaults to /admin/settings (this route's
      // historical target); a feature page that reuses this route to edit its
      // own `*.` keys in place passes its own page so the operator returns
      // there (#705), allowlisted the same way as /settings/set.
      const redirectTo = safeAdminRedirect(getString(req, "redirect"));
      // Section forms carry an implicit master toggle (the section's shortest
      // `.enabled` key) whose cascade skips dependents when off. A feature page
      // reusing this route has no such master — its master lives elsewhere
      // (e.g. `voicechannels.enabled`, owned by the enable notice) and is not
      // among the submitted keys — so it opts out with `no_cascade`, meaning
      // every submitted key is written rather than skipped.
      const noCascade = getCheckbox(req, "no_cascade");

      const rawKeys = body.keys;
      const keys: string[] = Array.isArray(rawKeys)
        ? rawKeys.map(String).filter((k) => k.length > 0)
        : typeof rawKeys === "string" && rawKeys.length > 0
          ? [rawKeys]
          : [];

      if (keys.length === 0) {
        await recordAudit(session, {
          action: "settings.save-section",
          targetId: category || null,
          result: "failure",
          errorMessage: "no keys submitted",
        });
        respondSectionFlash(
          req,
          res,
          {
            type: "err",
            text: `No settings submitted for section ${category || "(unknown)"}.`,
          },
          redirectTo,
        );
        return;
      }

      // Cascading disable (#485): when the section's master `.enabled` toggle
      // (the shortest boolean `.enabled` key in the section) is unchecked, the
      // dependent controls were greyed out client-side and aren't submitted.
      // Honour that here — write only the master flag and leave the rest
      // untouched, so disabling a feature can't silently clobber its
      // sub-settings (an absent — or cleared — number field would otherwise
      // be rejected, an absent string blanked).
      const masterKey = noCascade ? null : findSectionMasterKey(keys);
      const masterOff =
        masterKey !== null &&
        body[settingValueFieldName(masterKey)] !== "true" &&
        body[settingValueFieldName(masterKey)] !== true;

      // Phase 1: coerce every value before touching the DB. An array of
      // unique keys is required so a duplicate hidden input can't trick
      // the handler into double-writing or mis-counting rejections.
      const seen = new Set<string>();
      let coerced: Array<{
        key: string;
        value: string | number | boolean;
      }> = [];
      const rejected: Array<{ key: string; reason: string }> = [];
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (masterOff && key !== masterKey) continue;
        const raw = body[settingValueFieldName(key)];
        const r = coerceConfigValue(key, raw);
        if (r.ok) {
          coerced.push({ key, value: r.value });
        } else {
          rejected.push({ key, reason: r.reason });
        }
      }

      // Cross-feature dependency validation (#663). Validate the whole coerced
      // batch together (against the live config for keys outside it) so a
      // section that enables a feature and its dependency at once passes, while
      // a write that would break the dependency graph is rejected with an
      // operator-friendly message. Flagged keys join `rejected`, so the
      // existing all-or-nothing guard below blocks the save.
      if (coerced.length > 0) {
        const pending = Object.fromEntries(
          coerced.map((c) => [c.key, c.value]),
        );
        const issues =
          await ConfigService.getInstance().findDependencyIssues(pending);
        if (issues.length > 0) {
          const flagged = new Set(issues.map((i) => i.key as string));
          for (const issue of issues) {
            rejected.push({ key: issue.key, reason: issue.message });
          }
          coerced = coerced.filter((c) => !flagged.has(c.key));
        }
      }

      if (rejected.length > 0) {
        await recordAudit(session, {
          action: "settings.save-section",
          targetId: category || null,
          details: {
            rejected,
            attemptedCount: coerced.length + rejected.length,
          },
          result: "failure",
          errorMessage: rejected.map((r) => `${r.key}: ${r.reason}`).join("; "),
        });
        const detail = rejected.map((r) => `${r.key} (${r.reason})`).join(", ");
        respondSectionFlash(
          req,
          res,
          {
            type: "err",
            text: `No changes saved — ${rejected.length} invalid value${rejected.length === 1 ? "" : "s"} in ${category || "section"}: ${detail}.`,
          },
          redirectTo,
          rejected.map((r) => r.key),
        );
        return;
      }

      // Phase 2: apply. Snapshot `before` per key for the audit row.
      // `config.get()` returns null (not throw) on errors and for keys
      // that aren't stored, so fall back via `??` so unset keys record
      // their schema default in the audit instead of a misleading null.
      const config = ConfigService.getInstance();
      const applied: Array<{ key: string; before: unknown; after: unknown }> =
        [];
      const failed: Array<{ key: string; reason: string }> = [];
      for (const { key, value } of coerced) {
        const stored = await config.get(key);
        const before =
          stored ?? defaultConfig[key as keyof typeof defaultConfig];
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        try {
          // Dependencies were validated for the whole batch above; skip the
          // per-key check so intra-batch ordering can't trigger a false reject.
          await config.set(
            key,
            value,
            meta?.description ?? "",
            meta?.category ?? key.split(".")[0],
            { skipDependencyCheck: true },
          );
          applied.push({ key, before, after: value });
        } catch (err) {
          const text = err instanceof Error ? err.message : "set failed";
          // The audit row records which key failed (see `failed` below) so
          // the log message keeps the user-supplied key out of the format
          // string — CodeQL flags template interpolation of body fields as
          // log injection even when validation guarantees the value.
          logger.error("save-section: failed to write setting", err);
          failed.push({ key, reason: text });
        }
      }

      // Tri-state outcome that mirrors the YAML-import audit (see
      // `/settings/import/apply`): `result: "failure"` only when nothing
      // landed, otherwise `success` with a `partial` flag in details so
      // an audit query for `result: "success"` doesn't exclude partial
      // saves. The user-facing flash already uses `warn` for partial.
      const outcome: "ok" | "partial" | "failed" =
        failed.length === 0 ? "ok" : applied.length > 0 ? "partial" : "failed";
      await recordAudit(session, {
        action: "settings.save-section",
        targetId: category || null,
        details: {
          applied,
          failed,
          appliedCount: applied.length,
          failedCount: failed.length,
          outcome,
        },
        result: outcome === "failed" ? "failure" : "success",
        errorMessage:
          failed.length > 0
            ? failed.map((f) => `${f.key}: ${f.reason}`).join("; ")
            : null,
      });

      const label = category || "section";
      if (failed.length === 0) {
        respondSectionFlash(
          req,
          res,
          {
            type: "ok",
            text: `Saved ${applied.length} setting${applied.length === 1 ? "" : "s"} in ${label}.`,
          },
          redirectTo,
        );
        return;
      }
      const firstError = failed[0];
      respondSectionFlash(
        req,
        res,
        {
          type: applied.length > 0 ? "warn" : "err",
          text: `Saved ${applied.length}/${applied.length + failed.length} in ${label}. Failed: ${firstError.key} (${firstError.reason})${failed.length > 1 ? ` and ${failed.length - 1} more` : ""}.`,
        },
        redirectTo,
        failed.map((f) => f.key),
      );
    }),
  );

  router.post(
    "/settings/reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const botStatus = BotStatusService.getInstance(client);
      botStatus.setConfigReloadStatus();
      try {
        const commandManager = CommandManager.getInstance(client);
        await commandManager.registerCommands();
        await commandManager.populateClientCommands();
        await recordAudit(session, {
          action: "commands.reload",
          result: "success",
        });
        flashRedirect(res, "/admin/settings", {
          type: "ok",
          text: "Reloaded slash commands.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Command reload failed", err);
        await recordAudit(session, {
          action: "commands.reload",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Reload failed: ${text}`,
        });
      } finally {
        // Always restore the operational status even if the reload threw —
        // otherwise the bot would be stuck in "config reloading" forever.
        botStatus.setOperationalStatus();
      }
    }),
  );

  // ============================================================
  // Settings — YAML export / import (issue #383)
  // ============================================================

  // GET is exempt from CSRF; mounted on this router so requireSession runs.
  router.get(
    "/settings/export",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const config = ConfigService.getInstance();
        const all = await config.getAll();
        const exportObj: Record<string, unknown> = {};
        // Start from defaults so every public key has a value.
        for (const [k, v] of Object.entries(defaultConfig)) {
          if (!PROTECTED_KEYS.has(k)) exportObj[k] = v;
        }
        // Overlay with DB values.
        for (const entry of all) {
          if (!PROTECTED_KEYS.has(entry.key))
            exportObj[entry.key] = entry.value;
        }
        const yamlContent = yaml.dump(exportObj, { sortKeys: true });
        const filename = `koolbot-config-${new Date()
          .toISOString()
          .slice(0, 10)}.yaml`;
        await recordAudit(session, {
          action: "settings.export",
          details: { keys: Object.keys(exportObj).length },
          result: "success",
        });
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.type("application/x-yaml").send(yamlContent);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Settings export failed", err);
        await recordAudit(session, {
          action: "settings.export",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Export failed: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/settings/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const yamlText = getString(req, "yaml");
      if (!yamlText) {
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "Paste YAML before previewing.",
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = yaml.load(yamlText);
      } catch (err) {
        const text = err instanceof Error ? err.message : "parse error";
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Invalid YAML: ${text}`,
        });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "YAML must be a key→value mapping, not a list or scalar.",
        });
        return;
      }

      const config = ConfigService.getInstance();
      const all = await config.getAll();
      const currentByKey = new Map(all.map((e) => [e.key, e.value]));

      const rows: ImportDiffRow[] = [];
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (PROTECTED_KEYS.has(key)) {
          rows.push({ key, status: "rejected", reason: "protected key" });
          continue;
        }
        if (!(key in defaultConfig)) {
          rows.push({ key, status: "rejected", reason: "unknown key" });
          continue;
        }
        // Surface type-mismatch in the preview so a silent drop at apply
        // isn't the first sign the user sees.
        const coerced = coerceConfigValue(key, value);
        if (!coerced.ok) {
          rows.push({
            key,
            status: "rejected",
            reason: `type mismatch (${coerced.reason})`,
          });
          continue;
        }
        const before = currentByKey.has(key)
          ? currentByKey.get(key)
          : defaultConfig[key as keyof typeof defaultConfig];
        rows.push({
          key,
          status: "pending",
          before,
          after: coerced.value,
        });
      }

      res.type("text/html").send(
        renderImportDiffPage({
          csrfToken: getCsrfFromReq(req),
          remainingMs: getDisplayedRemainingMs(session),
          navFeatureStatus: await navStatusForPage(),
          rows,
          yamlText,
        }),
      );
    }),
  );

  router.post(
    "/settings/import/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const yamlText = getString(req, "yaml");

      let parsed: unknown;
      try {
        parsed = yaml.load(yamlText);
      } catch (err) {
        const text = err instanceof Error ? err.message : "parse error";
        await recordAudit(session, {
          action: "settings.import",
          result: "failure",
          errorMessage: `parse: ${text}`,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Invalid YAML: ${text}`,
        });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        await recordAudit(session, {
          action: "settings.import",
          result: "failure",
          errorMessage: "not a mapping",
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "YAML must be a mapping.",
        });
        return;
      }

      const config = ConfigService.getInstance();
      let applied = 0;
      const failed: Array<{ key: string; reason: string }> = [];

      // Phase 1: coerce every importable key. An import is a (possibly
      // partial) config snapshot, so collect the whole valid set before
      // writing — the dependency check below judges them together.
      const pending: Array<{ key: string; value: string | number | boolean }> =
        [];
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (PROTECTED_KEYS.has(key)) {
          failed.push({ key, reason: "protected" });
          continue;
        }
        if (!(key in defaultConfig)) {
          failed.push({ key, reason: "unknown" });
          continue;
        }
        const coerced = coerceConfigValue(key, value);
        if (!coerced.ok) {
          failed.push({ key, reason: coerced.reason });
          continue;
        }
        pending.push({ key, value: coerced.value });
      }

      // Cross-feature dependency validation (#663). Validate the imported set
      // as a batch so a snapshot that enables a feature and its dependency
      // together imports cleanly, while one that breaks the dependency graph
      // has the offending keys rejected (the rest still apply).
      let toWrite = pending;
      if (pending.length > 0) {
        const issues = await config.findDependencyIssues(
          Object.fromEntries(pending.map((p) => [p.key, p.value])),
        );
        if (issues.length > 0) {
          const flagged = new Set(issues.map((i) => i.key as string));
          for (const issue of issues) {
            failed.push({ key: issue.key, reason: issue.message });
          }
          toWrite = pending.filter((p) => !flagged.has(p.key));
        }
      }

      // Phase 2: apply the validated set. Skip the per-key check — the batch
      // was already validated, and per-key ordering would falsely reject an
      // intra-snapshot dependency pair.
      for (const { key, value } of toWrite) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        try {
          await config.set(
            key,
            value,
            meta?.description ?? "",
            meta?.category ?? key.split(".")[0],
            { skipDependencyCheck: true },
          );
          applied++;
        } catch (err) {
          const text = err instanceof Error ? err.message : "set failed";
          // Static message: `key` comes from the uploaded YAML, and the
          // failing key is already reported through `failed` below.
          logger.error("Import: failed to set setting", err);
          failed.push({ key, reason: text });
        }
      }

      // Tri-state outcome so an audit query for `result: "success"` doesn't
      // exclude partial imports (e.g. 99 keys applied with 1 type-mismatch).
      // `result` mirrors what the user-facing flash shows: `failure` only
      // when nothing landed; otherwise `success` with a `partial` flag in
      // the details for reporting.
      const outcome: "ok" | "partial" | "failed" =
        failed.length === 0 ? "ok" : applied > 0 ? "partial" : "failed";
      await recordAudit(session, {
        action: "settings.import",
        details: {
          applied,
          failed: failed.length,
          failedKeys: failed,
          outcome,
        },
        result: outcome === "failed" ? "failure" : "success",
        errorMessage:
          failed.length > 0
            ? failed
                .slice(0, 5)
                .map((f) => `${f.key}: ${f.reason}`)
                .join("; ")
            : null,
      });

      const summary =
        failed.length === 0
          ? `Imported ${applied} setting${applied === 1 ? "" : "s"}.`
          : `Imported ${applied}, skipped ${failed.length} (first: ${failed[0].key} — ${failed[0].reason}).`;
      flashRedirect(res, "/admin/settings", {
        type: failed.length === 0 ? "ok" : applied > 0 ? "warn" : "err",
        text: summary,
      });
    }),
  );

  return router;
}
