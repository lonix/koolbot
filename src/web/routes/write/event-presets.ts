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
  DUPLICATE_NAME,
  PRESET_FORM_FIELDS,
  PRESET_LOBBY_FIELDS,
  setPresetEnabled,
  updateLibraryPreset,
  validatePresetForm,
} from "../../../services/event-group-preset-service.js";
import {
  publishPersonalPreset,
  unpublishPersonalPreset,
} from "../../../services/event-personal-preset-service.js";
import {
  GROUP_FORM_FIELDS,
  GROUP_FORM_MAX_ROWS,
  groupRowField,
  resolveGroupCountLimits,
} from "../../../services/event-groups.js";
import type { FormValues } from "../../form-errors.js";
import { EVENT_PRESET_FORM } from "../../event-presets-page.js";
import { recordAudit } from "../../audit.js";
import {
  asyncHandler,
  flashRedirect,
  flashRedirectQuery,
  type Flash,
  getString,
  refuseForm,
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

/**
 * What the preset editor submitted, as a refused editor shows it (#1523): every
 * field exactly as typed, the ticks as "1" or "", and the group rows in the
 * order of the form (they are contiguous, so the first missing one ends them).
 */
export function presetFormValues(body: unknown): FormValues {
  const source = (body ?? {}) as Record<string, unknown>;
  const str = (name: string): string =>
    typeof source[name] === "string" ? (source[name] as string) : "";
  const values: FormValues = {};
  for (const name of [
    PRESET_FORM_FIELDS.id,
    PRESET_FORM_FIELDS.name,
    PRESET_FORM_FIELDS.description,
    GROUP_FORM_FIELDS.label,
    GROUP_FORM_FIELDS.leaderLabel,
    GROUP_FORM_FIELDS.leadMinutes,
    ...Object.values(PRESET_LOBBY_FIELDS),
  ]) {
    values[name] = str(name);
  }
  for (const name of [
    GROUP_FORM_FIELDS.tags,
    GROUP_FORM_FIELDS.captainsLobby,
  ]) {
    values[name] = str(name).trim() ? "1" : "";
  }
  for (let i = 0; i < GROUP_FORM_MAX_ROWS; i++) {
    if (typeof source[groupRowField(i, "name")] !== "string") break;
    for (const field of ["name", "kind", "size", "tag", "marker"] as const) {
      values[groupRowField(i, field)] = str(groupRowField(i, field));
    }
  }
  return values;
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
        // Each refused field is marked in the editor, which comes back holding
        // what was typed. Only if no message could be tied to the page does the
        // old redirect to the editor (with a flash) answer.
        if (
          await refuseForm(req, res, {
            page: PAGE,
            formId: EVENT_PRESET_FORM,
            errors: checked.fields,
            values: presetFormValues(req.body),
            fallback: (flash) =>
              backToEditor(res, id, {
                ...flash,
                text: `Preset not saved. ${checked.errors.join(" ")}`,
              }),
          })
        ) {
          return;
        }
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
      } else if (
        result.error === DUPLICATE_NAME &&
        (await refuseForm(req, res, {
          page: PAGE,
          formId: EVENT_PRESET_FORM,
          errors: { [PRESET_FORM_FIELDS.name]: result.error },
          values: presetFormValues(req.body),
          fallback: (flash) =>
            backToEditor(res, id, {
              ...flash,
              text: `Preset not saved. ${result.error}`,
            }),
        }))
      ) {
        return;
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
