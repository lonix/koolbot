/**
 * Event group preset library (#1200): create, edit, delete and switch presets
 * on or off for the whole server.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf`, so every route
 * here is admin-only and CSRF-checked. Nothing here touches an event: events
 * keep their own copy of the groups they were created with.
 */

import { Router } from "express";
import { ConfigService } from "../../../services/config-service.js";
import {
  createLibraryPreset,
  deleteLibraryPreset,
  PRESET_FORM_FIELDS,
  setPresetEnabled,
  updateLibraryPreset,
  validatePresetForm,
} from "../../../services/event-group-preset-service.js";
import { resolveGroupCountLimits } from "../../../services/event-groups.js";
import { recordAudit } from "../../audit.js";
import {
  asyncHandler,
  flashRedirect,
  flashRedirectQuery,
  type Flash,
  getString,
  requireSessionContext,
} from "./helpers.js";

const PAGE = "/admin/events/presets";

/**
 * Back to the editor after a refused save. An edit goes back to that preset's
 * editor (`?edit=`), so the admin's retry is still an edit and not a second,
 * new preset next to it.
 */
function backToEditor(
  res: Parameters<typeof flashRedirect>[0],
  id: string,
  flash: Flash,
): void {
  if (!id) {
    flashRedirect(res, PAGE, flash);
    return;
  }
  res.redirect(
    303,
    `${PAGE}?edit=${encodeURIComponent(id)}&${flashRedirectQuery(flash)}`,
  );
}

export function createEventPresetsRouter(): Router {
  const router = Router();

  router.post(
    "/events/presets/save",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = getString(req, PRESET_FORM_FIELDS.id);
      const config = ConfigService.getInstance();
      const [defaultCount, configuredMax] = await Promise.all([
        config.getNumber("events.groups.default_count", 2),
        config.getNumber("events.groups.max_count", 15),
      ]);
      const { maxCount } = resolveGroupCountLimits(defaultCount, configuredMax);
      const checked = validatePresetForm(req.body, { maxCount });
      if (!checked.ok) {
        backToEditor(res, id, {
          type: "err",
          text: `Preset not saved. ${checked.errors.join(" ")}`,
        });
        return;
      }
      const data = checked.data;
      const action = id ? "event-preset.update" : "event-preset.create";
      let targetId = id;
      let result: { ok: true } | { ok: false; error: string };
      if (id) {
        result = await updateLibraryPreset(session.guildId, id, data);
      } else {
        const created = await createLibraryPreset(session.guildId, data);
        result = created;
        if (created.ok) targetId = created.id;
      }
      await recordAudit(session, {
        action,
        targetId,
        details: {
          name: data.name,
          groups: data.groups.length,
          groupLabel: data.groupLabel,
          channelLeadMinutes: data.channelLeadMinutes,
        },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      if (result.ok) {
        flashRedirect(res, PAGE, {
          type: "ok",
          text: id
            ? `Saved preset "${data.name}". Events that already used it are unchanged.`
            : `Added preset "${data.name}". It is on, so hosts can pick it now.`,
        });
      } else {
        backToEditor(res, id, {
          type: "err",
          text: `Preset not saved. ${result.error}`,
        });
      }
    }),
  );

  router.post(
    "/events/presets/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = getString(req, "id");
      const wanted = getString(req, "enabled");
      if (wanted !== "0" && wanted !== "1") {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Nothing changed: the switch value was missing.",
        });
        return;
      }
      const enabled = wanted === "1";
      const result = await setPresetEnabled(session.guildId, id, enabled);
      await recordAudit(session, {
        action: "event-preset.toggle",
        targetId: id,
        details: { enabled },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text: `Preset "${result.label}" is now ${enabled ? "on" : "off"}. Events that already used it are unchanged.`,
            }
          : { type: "err", text: result.error },
      );
    }),
  );

  router.post(
    "/events/presets/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = getString(req, "id");
      const result = await deleteLibraryPreset(session.guildId, id);
      await recordAudit(session, {
        action: "event-preset.delete",
        targetId: id,
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text: "Preset deleted. Events that already used it keep their groups.",
            }
          : { type: "err", text: result.error },
      );
    }),
  );

  return router;
}
