/**
 * A host's own event group presets (#1216): `/me/events/presets`.
 *
 * Mounted by `createUserRouter` behind `requireSession` and the `/me` write
 * limiter; this router adds CSRF on every unsafe method itself. Any signed-in
 * member may keep presets (the host check is only used to prefill the editor
 * from an event, which needs `isEventHost`: the creator or an admin). Every
 * read and write is scoped to the session's own user id and guild by the
 * service, so a preset id that belongs to someone else is "not found".
 */

import { Router, type Request, type Response } from "express";
import type { Client } from "discord.js";
import { ConfigService } from "../../services/config-service.js";
import {
  eventSetupToFormValues,
  parsePersonalPresetId,
  PRESET_FORM_FIELDS,
  presetToFormValues,
  validatePresetForm,
  type PresetEntry,
} from "../../services/event-group-preset-service.js";
import {
  createPersonalPreset,
  deletePersonalPreset,
  listPersonalPresets,
  updatePersonalPreset,
} from "../../services/event-personal-preset-service.js";
import {
  copyGroupSetup,
  resolveGroupCountLimits,
} from "../../services/event-groups.js";
import { EventService } from "../../services/event-service.js";
import { isEventHost } from "../event-host.js";
import {
  boundAuditEntry,
  recordAudit as recordAuditUnbounded,
  type AuditEntry,
} from "../audit.js";
import { requireCsrf } from "../csrf.js";
import { getDisplayedRemainingMs } from "../admin-layout.js";
import { readMeSurfaceFlags } from "../me-surfaces.js";
import { renderUserPage } from "../user-layout.js";
import { renderMyEventPresetsBody } from "../me-event-presets-page.js";
import { readSignedFlash, signFlash, truncateFlash } from "../http-flash.js";
import type { AuthenticatedRequest } from "../session.js";
import logger from "../../utils/logger.js";

const PAGE = "/me/events/presets";

// The ids come from the member, and failed requests are audited too, so every
// row written here is bounded first (#1142).
const recordAudit = (
  session: Parameters<typeof recordAuditUnbounded>[0],
  entry: AuditEntry,
): Promise<void> => recordAuditUnbounded(session, boundAuditEntry(entry));

function csrfOf(req: Request): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

function bodyString(req: Request, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" ? raw.trim() : "";
}

interface Flash {
  type: "ok" | "err";
  text: string;
}

/** Redirect with a signed flash (a bare query-string flash is ignored, #1149). */
function redirectWith(res: Response, path: string, flash: Flash): void {
  const text = truncateFlash(flash.text);
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
    sig: signFlash(flash.type, text),
  }).toString();
  const sep = path.includes("?") ? "&" : "?";
  res.redirect(303, `${path}${sep}${qs}`);
}

/** Back to the editor after a refused save, so a retry of an edit stays an edit. */
function backToEditor(res: Response, id: string, flash: Flash): void {
  redirectWith(
    res,
    // Only a well-formed id is echoed back into the URL; anything else (an
    // oversized or forged value) goes to the plain page.
    parsePersonalPresetId(id) ? `${PAGE}?edit=${encodeURIComponent(id)}` : PAGE,
    flash,
  );
}

async function readLimits(): Promise<{
  maxCount: number;
  defaultCount: number;
}> {
  const config = ConfigService.getInstance();
  const [defaultCount, configuredMax] = await Promise.all([
    config.getNumber("events.groups.default_count", 2),
    config.getNumber("events.groups.max_count", 15),
  ]);
  return resolveGroupCountLimits(defaultCount, configuredMax);
}

export function createMeEventPresetsRouter(client: Client): Router {
  const router = Router();
  router.use(requireCsrf);

  router.get("/", (req, res, next) => {
    const session = (req as AuthenticatedRequest).webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    const { guildId, discordUserId: userId } = session;
    const query = req.query as Record<string, unknown>;
    const str = (name: string): string => {
      const raw = query[name];
      return typeof raw === "string" ? raw.trim() : "";
    };
    void (async (): Promise<void> => {
      const [limits, flags] = await Promise.all([
        readLimits(),
        readMeSurfaceFlags(),
      ]);
      let presets: PresetEntry[] | null = null;
      try {
        presets = await listPersonalPresets(guildId, userId);
      } catch (err) {
        logger.warn("Could not list personal event presets:", err);
      }
      let editing: { id: string; label: string } | null = null;
      let editUnavailable = false;
      let values: Record<string, string> = {};
      let prefillNote: string | null = null;
      const editId = str("edit");
      const fromEventId = str("fromEvent");
      if (editId) {
        const entry = presets?.find((p) => p.id === editId);
        if (entry) {
          editing = { id: entry.id, label: entry.label };
          values = presetToFormValues(entry);
        } else if (presets === null) {
          // Do not fall back to a blank add form: saving it would add a copy.
          editUnavailable = true;
        } else {
          prefillNote =
            "That preset no longer exists. You can add a new one instead.";
        }
      } else if (fromEventId) {
        const event = await EventService.getInstance(client)
          .getEvent(fromEventId)
          .catch(() => null);
        // Only the event's host (its creator, or an admin) may copy its layout.
        if (event && isEventHost(session, event) && event.groupsEnabled) {
          values = eventSetupToFormValues(copyGroupSetup(event));
          prefillNote = `Prefilled from the groups of your event "${event.title}". Give the preset a name and save it. The event itself is not changed.`;
        } else {
          prefillNote =
            "That event was not found, has no groups, or is not yours to host.";
        }
      }
      res.type("text/html").send(
        renderUserPage({
          title: "My event presets",
          active: "/me/",
          body: renderMyEventPresetsBody({
            csrfToken: csrfOf(req),
            presets,
            editing,
            editUnavailable,
            values,
            prefillNote,
            ...limits,
          }),
          csrfToken: csrfOf(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash: readSignedFlash(req.query),
          ...flags,
        }),
      );
    })().catch(next);
  });

  router.post("/save", (req, res, next) => {
    const session = (req as AuthenticatedRequest).webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    const { guildId, discordUserId: userId } = session;
    const id = bodyString(req, PRESET_FORM_FIELDS.id);
    void (async (): Promise<void> => {
      const { maxCount } = await readLimits();
      const checked = validatePresetForm(req.body, { maxCount });
      if (!checked.ok) {
        backToEditor(res, id, {
          type: "err",
          text: `Preset not saved. ${checked.errors.join(" ")}`,
        });
        return;
      }
      const data = checked.data;
      let result: { ok: true } | { ok: false; error: string };
      let targetId = id;
      if (id) {
        result = await updatePersonalPreset(guildId, userId, id, data);
      } else {
        const created = await createPersonalPreset(guildId, userId, data);
        result = created;
        if (created.ok) targetId = created.id;
      }
      await recordAudit(session, {
        action: id ? "event-preset.update" : "event-preset.create",
        targetId,
        details: {
          scope: "personal",
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
        redirectWith(res, PAGE, {
          type: "ok",
          text: id
            ? `Saved your preset "${data.name}". Events that already used it are unchanged.`
            : `Saved your preset "${data.name}". It is offered when you set the groups of an event.`,
        });
      } else {
        backToEditor(res, id, {
          type: "err",
          text: `Preset not saved. ${result.error}`,
        });
      }
    })().catch(next);
  });

  router.post("/delete", (req, res, next) => {
    const session = (req as AuthenticatedRequest).webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    const { guildId, discordUserId: userId } = session;
    const id = bodyString(req, "id");
    void (async (): Promise<void> => {
      const result = await deletePersonalPreset(guildId, userId, id);
      await recordAudit(session, {
        action: "event-preset.delete",
        targetId: id,
        details: { scope: "personal" },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      redirectWith(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text: `Deleted your preset "${result.name}". Events that already used it keep their groups.`,
            }
          : { type: "err", text: result.error },
      );
    })().catch(next);
  });

  return router;
}
