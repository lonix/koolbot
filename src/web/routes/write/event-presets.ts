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
import {
  publishPersonalPreset,
  unpublishPersonalPreset,
} from "../../../services/event-personal-preset-service.js";
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
          tagsEnabled: data.tagsEnabled,
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

  // Publish / unpublish a host's personal preset (#1216). Admin-only like the
  // rest of this router. Publishing copies the preset into the library; the
  // audit rows use the library's action names with `scope: "personal"` on the
  // create/delete half and a `.publish` / `.unpublish` row of their own.
  router.post(
    "/events/presets/publish",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = getString(req, "id");
      const config = ConfigService.getInstance();
      const [defaultCount, configuredMax] = await Promise.all([
        config.getNumber("events.groups.default_count", 2),
        config.getNumber("events.groups.max_count", 15),
      ]);
      const { maxCount } = resolveGroupCountLimits(defaultCount, configuredMax);
      const result = await publishPersonalPreset(session.guildId, id, {
        maxCount,
      });
      await recordAudit(session, {
        action: "event-preset.publish",
        targetId: id,
        details: result.ok
          ? { scope: "personal", libraryId: result.id, name: result.name }
          : { scope: "personal" },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text: `Published "${result.name}". It is in the server's presets, switched on, so every host can pick it.`,
            }
          : { type: "err", text: `Not published. ${result.error}` },
      );
    }),
  );

  router.post(
    "/events/presets/unpublish",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = getString(req, "id");
      const result = await unpublishPersonalPreset(session.guildId, id);
      await recordAudit(session, {
        action: "event-preset.unpublish",
        targetId: id,
        details: result.ok
          ? { scope: "personal", libraryId: result.libraryId }
          : { scope: "personal" },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text: "Unpublished. The server copy is deleted; events that already used it keep their groups, and the host keeps their own preset.",
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
