/**
 * The shared tail of the three Re-post routes (#1428): audit once, then flash
 * what happened. Kept in one place so the quotes header, the notices header and
 * the rules message all say the same things the same way.
 */

import type { Response } from "express";
import {
  describeRepost,
  type RepostResult,
} from "../../../services/managed-message-repost.js";
import { recordAudit } from "../../audit.js";
import type { WebSessionContext } from "../../session.js";
import { flashRedirect, type Flash } from "./helpers.js";

export interface RepostResponseOptions {
  /** Page to return to, e.g. "/admin/quotes". */
  page: string;
  /** Audit action, e.g. "quote.header-repost". */
  action: string;
  /** What was re-posted, for the flash: "The quotes header". */
  what: string;
  /** Appended to a success flash (what the admin should know next). */
  extra?: string;
}

export async function finishRepost(
  res: Response,
  session: WebSessionContext,
  result: RepostResult,
  opts: RepostResponseOptions,
): Promise<void> {
  await recordAudit(
    session,
    result.ok
      ? {
          action: opts.action,
          targetId: result.messageId,
          details: {
            oldMessageId: result.oldMessageId,
            oldMessage: result.old,
          },
          result: "success",
        }
      : {
          action: opts.action,
          details: { reason: result.reason },
          result: "failure",
          errorMessage: result.error,
        },
  );
  const flash: Flash = result.ok
    ? describeRepost(result, opts.what, opts.extra ?? "")
    : { type: result.reason === "stale" ? "warn" : "err", text: result.error };
  flashRedirect(res, opts.page, flash);
}
