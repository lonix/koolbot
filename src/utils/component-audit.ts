/**
 * Command audit for button, select-menu and modal interactions (#1147).
 *
 * `CommandManager.executeCommand` audits slash commands, but components are
 * dispatched from `src/index.ts` without going through it, so a member's
 * clicks never reached `DiscordCommandAuditLog`. This records one row per
 * component interaction through the same `recordCommandAudit` and the same
 * `core.command_audit.enabled` switch, so retention and the Command Audit page
 * need nothing new.
 *
 * What a row never carries:
 * - The custom id. Ids embed channel and member ids
 *   (`vc_control_letin_<channel>_<member>_<owner>`), so the row names the
 *   handler through a fixed label from {@link COMPONENT_AUDIT_PREFIXES}
 *   instead, which also keeps the page's command filter a finite list.
 * - Submitted modal text or selected values.
 * - The error message (a handler may echo input); only the error's class name.
 *
 * Writes are bounded per member: a member mashing a button cannot turn one
 * click into one database row without limit, whether or not the optional
 * `ratelimit.*` switch is on. Dropped rows are reported in the log, once per
 * window.
 */

import type { Interaction } from "discord.js";
import { ConfigService } from "../services/config-service.js";
import { CooldownManager } from "../services/cooldown-manager.js";
import logger from "./logger.js";
import { recordCommandAudit } from "./record-command-audit.js";
import { voiceRoomNameOf } from "./voice-room-name.js";

export type ComponentKind = "button" | "select" | "modal";

/** Audit rows one member can produce per window. */
export const COMPONENT_AUDIT_MAX_PER_WINDOW = 30;
export const COMPONENT_AUDIT_WINDOW_SECONDS = 60;

/**
 * Custom-id prefix (or exact id, when it does not end in `_` or `:`) to the
 * stable label stored as `commandName`. Mirrors the dispatch in
 * `src/index.ts`; a test fails when a prefix routed there has no entry here.
 */
export const COMPONENT_AUDIT_PREFIXES: Record<
  ComponentKind,
  ReadonlyArray<readonly [string, string]>
> = {
  button: [
    ["vc_control_", "component:vc_control"],
    ["vc_preset_", "component:vc_preset"],
    ["event_rsvp_", "component:event_rsvp"],
    ["lfg_", "component:lfg"],
    ["rules:accept", "component:rules_accept"],
    ["reactrole:btn:", "component:reactrole_button"],
    ["evcust:", "component:event_customise"],
  ],
  select: [
    ["vc_transfer_select_", "component:vc_transfer_select"],
    ["vc_preset_", "component:vc_preset_select"],
    ["reactrole:sel", "component:reactrole_select"],
  ],
  modal: [
    ["vc_modal_", "component:vc_modal"],
    ["evcust:", "component:event_customise_modal"],
  ],
};

export const COMPONENT_AUDIT_UNKNOWN = "component:unknown";

/** Every label a row can carry, for the Command Audit page's filter. */
export const COMPONENT_AUDIT_LABELS: readonly string[] = [
  ...Object.values(COMPONENT_AUDIT_PREFIXES)
    .flat()
    .map(([, label]) => label),
  COMPONENT_AUDIT_UNKNOWN,
];

/** The fixed audit label for a component, never derived from member data. */
export function componentAuditLabel(
  kind: ComponentKind,
  customId: string,
): string {
  for (const [prefix, label] of COMPONENT_AUDIT_PREFIXES[kind]) {
    const exact = !prefix.endsWith("_") && !prefix.endsWith(":");
    if (exact ? customId === prefix : customId.startsWith(prefix)) {
      return label;
    }
  }
  return COMPONENT_AUDIT_UNKNOWN;
}

let limiter: CooldownManager | null = null;
function auditLimiter(): CooldownManager {
  limiter ??= new CooldownManager();
  return limiter;
}

/** Drop the per-member write bound. For tests. */
export function resetComponentAuditLimiter(): void {
  limiter?.destroy();
  limiter = null;
}

export interface ComponentAudit {
  /** The dispatcher had no handler for this id: recorded as `denied`. */
  unrecognised(): void;
  /** The handler returned: `success`, or `denied` when unrecognised. */
  done(): Promise<void>;
  /** The handler threw: `error`, with only the error's class name. */
  failed(error: unknown): Promise<void>;
}

type AuditableInteraction = Pick<
  Interaction,
  "guildId" | "channelId" | "channel" | "user"
> & {
  customId: string;
};

/**
 * Start auditing a component interaction. Call it before dispatching, then
 * `done()` or `failed()` once. Neither can throw: an audit failure must never
 * break the member's click.
 */
export function startComponentAudit(
  interaction: AuditableInteraction,
  kind: ComponentKind,
): ComponentAudit {
  const startedAt = Date.now();
  const label = componentAuditLabel(kind, interaction.customId);
  let handled = true;

  const record = async (
    result: "success" | "error" | "denied",
    errorMessage: string | null,
  ): Promise<void> => {
    try {
      if (!interaction.guildId) return;
      const enabled = await ConfigService.getInstance()
        .getBoolean("core.command_audit.enabled", true)
        .catch(() => true);
      if (!enabled) return;

      const userId = interaction.user.id;
      const bound = auditLimiter();
      if (
        bound.isRateLimited(
          userId,
          COMPONENT_AUDIT_MAX_PER_WINDOW,
          COMPONENT_AUDIT_WINDOW_SECONDS,
        )
      ) {
        if (
          !bound.isOnCooldown(
            userId,
            "dropped-notice",
            COMPONENT_AUDIT_WINDOW_SECONDS,
          )
        ) {
          bound.setCooldown(userId, "dropped-notice");
          logger.warn(
            `Component audit rows for member ${userId} are being dropped: more than ${COMPONENT_AUDIT_MAX_PER_WINDOW} in ${COMPONENT_AUDIT_WINDOW_SECONDS}s`,
          );
        }
        return;
      }
      bound.trackCommandExecution(userId, COMPONENT_AUDIT_WINDOW_SECONDS);

      await recordCommandAudit({
        guildId: interaction.guildId,
        discordUserId: userId,
        commandName: label,
        subcommand: null,
        channelId: interaction.channelId ?? null,
        channelName: voiceRoomNameOf(interaction.channel),
        result,
        errorMessage,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.error("Failed to record component audit entry", error);
    }
  };

  return {
    unrecognised: (): void => {
      handled = false;
    },
    done: (): Promise<void> =>
      handled
        ? record("success", null)
        : record("denied", "No handler for this component"),
    failed: (error: unknown): Promise<void> =>
      record(
        "error",
        (error instanceof Error ? error.name : "UnknownError").slice(0, 100),
      ),
  };
}
