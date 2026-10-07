/**
 * Support-ticket actions on `/admin/tickets` (#1004): claim, close, reopen.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf`. Each handler is a
 * thin wrapper over `TicketChannelManager` — the same transitions `/ticket`
 * runs in Discord — and records exactly one audit entry.
 */

import { Router } from "express";
import { Client } from "discord.js";
import {
  TicketChannelManager,
  type TicketFailure,
} from "../../../services/ticket-channel-manager.js";
import { recordAudit } from "../../audit.js";
import {
  asyncHandler,
  flashRedirect,
  requireSessionContext,
} from "./helpers.js";

const TICKETS_PAGE = "/admin/tickets";

const FAILURE_TEXT: Record<TicketFailure, string> = {
  disabled: "Tickets are disabled.",
  "no-staff-role": "Choose a ticket staff role first.",
  "not-found": "The ticket's channel no longer exists.",
  "already-closed": "That ticket is already closed.",
  "not-closed": "That ticket isn't closed.",
  "already-claimed": "That ticket is already claimed.",
  "discord-error": "Discord refused the change — check the bot's permissions.",
};

type Verb = "claim" | "close" | "reopen";

const DONE_TEXT: Record<Verb, string> = {
  claim: "Ticket claimed.",
  close: "Ticket closed.",
  reopen: "Ticket reopened.",
};

export function createTicketsRouter(client: Client): Router {
  const router = Router();

  for (const verb of ["claim", "close", "reopen"] as const) {
    router.post(
      `/tickets/:id/${verb}`,
      asyncHandler(async (req, res) => {
        const session = requireSessionContext(req);
        const id = String(req.params.id);
        const manager = TicketChannelManager.getInstance(client);
        try {
          const ticket = await manager.findById(session.guildId, id);
          if (!ticket) {
            await recordAudit(session, {
              action: `ticket.${verb}`,
              targetId: id,
              result: "failure",
              errorMessage: "not found",
            });
            flashRedirect(res, TICKETS_PAGE, {
              type: "err",
              text: `Ticket ${id} not found.`,
            });
            return;
          }
          const actor = session.discordUserId;
          const result =
            verb === "claim"
              ? await manager.claimTicket(ticket, actor)
              : verb === "close"
                ? await manager.closeTicket(ticket, actor)
                : await manager.reopenTicket(ticket, actor);
          await recordAudit(session, {
            action: `ticket.${verb}`,
            targetId: id,
            result: result.ok ? "success" : "failure",
            errorMessage: result.ok ? null : result.reason,
          });
          flashRedirect(
            res,
            TICKETS_PAGE,
            result.ok
              ? { type: "ok", text: DONE_TEXT[verb] }
              : { type: "err", text: FAILURE_TEXT[result.reason] },
          );
        } catch (err) {
          await recordAudit(session, {
            action: `ticket.${verb}`,
            targetId: id,
            result: "failure",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          flashRedirect(res, TICKETS_PAGE, {
            type: "err",
            text: `Could not ${verb} the ticket.`,
          });
        }
      }),
    );
  }

  return router;
}
