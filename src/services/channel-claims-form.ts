import {
  CLAIM_ACTIONS,
  featureTarget,
  type ChannelClaim,
  type ClaimAction,
} from "./channel-claims.js";

/**
 * Parsing for the claims form (#1022). The browser posts flat fields
 * (`action_<channelId>`, `roles_<channelId>`, …); the preview page then carries
 * the parsed claims in one hidden JSON field, which the apply step parses again
 * with the same strict validation. Both inputs are untrusted: ids are checked
 * against the scanned server and feature keys against the fixed registry.
 */

const SNOWFLAKE = /^\d{15,25}$/;
const MAX_CLAIMS = 500;
const MAX_ROLES = 100;

export interface ClaimsInput {
  claims: ChannelClaim[];
  /** Why something was ignored; shown to the admin rather than silently dropped. */
  problems: string[];
}

const asString = (v: unknown): string =>
  typeof v === "string" ? v.trim() : "";

const asList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => SNOWFLAKE.test(x))
    .slice(0, MAX_ROLES);
};

const asFlag = (v: unknown): boolean => v === "1" || v === "on" || v === true;

function isAction(value: string): value is ClaimAction {
  return (CLAIM_ACTIONS as readonly string[]).includes(value);
}

/** Drop everything that is not a no-op, keeping the claim small. */
function isNoop(c: ChannelClaim): boolean {
  return c.action === "leave" && !c.bindKey;
}

/**
 * Read the flat form. `categories` maps a category id to its child channel
 * ids, so a category's `bulk_<id>` action (e.g. "make every channel in this
 * category read-only") can fan out to children that were left alone.
 */
export function claimsFromForm(
  body: Record<string, unknown>,
  channels: ReadonlyArray<{
    id: string;
    kind: string;
    parentId: string | null;
  }>,
): ClaimsInput {
  const problems: string[] = [];
  const claims = new Map<string, ChannelClaim>();
  const known = new Set(channels.map((c) => c.id));

  const read = (id: string): ChannelClaim | null => {
    const action = asString(body[`action_${id}`]) || "leave";
    if (!isAction(action)) {
      problems.push(`Ignored an unknown action for channel ${id}.`);
      return null;
    }
    const bindKey = asString(body[`bind_${id}`]);
    if (bindKey && !featureTarget(bindKey)) {
      problems.push(`Ignored an unknown feature for channel ${id}.`);
      return null;
    }
    return {
      channelId: id,
      action,
      ...(bindKey ? { bindKey } : {}),
      roleIds: asList(body[`roles_${id}`]),
      ...(asString(body[`min_${id}`])
        ? { minGroupId: asString(body[`min_${id}`]) }
        : {}),
      allowReactions: asFlag(body[`react_${id}`]),
      lockReplies: asFlag(body[`lock_${id}`]),
      approveReplace: asFlag(body[`replace_${id}`]),
      voiceManagedOnly: asFlag(body[`vmo_${id}`]),
      usePrefix: asFlag(body[`prefix_${id}`]),
    };
  };

  for (const channel of channels) {
    const claim = read(channel.id);
    if (claim && !isNoop(claim)) claims.set(channel.id, claim);
  }

  // Bulk: a category's bulk action reaches children the admin left alone.
  // Approval to replace permissions is never inherited: each channel needs its
  // own tick, so "apply all" can't approve a destructive step implicitly.
  for (const category of channels.filter((c) => c.kind === "category")) {
    const bulk = asString(body[`bulk_${category.id}`]);
    if (!bulk) continue;
    if (!isAction(bulk) || bulk === "leave") {
      if (bulk) problems.push(`Ignored an unknown bulk action.`);
      continue;
    }
    for (const child of channels) {
      if (child.parentId !== category.id || child.kind === "category") continue;
      if (claims.has(child.id)) continue; // the row's own choice wins
      claims.set(child.id, {
        channelId: child.id,
        action: bulk,
        roleIds: asList(body[`roles_${category.id}`]),
        ...(asString(body[`min_${category.id}`])
          ? { minGroupId: asString(body[`min_${category.id}`]) }
          : {}),
        allowReactions: asFlag(body[`react_${category.id}`]),
        lockReplies: asFlag(body[`lock_${category.id}`]),
      });
    }
  }

  const list = [...claims.values()].filter((c) => known.has(c.channelId));
  if (list.length > MAX_CLAIMS) {
    problems.push(`At most ${MAX_CLAIMS} claims can be planned at once.`);
    list.length = MAX_CLAIMS;
  }
  return { claims: list, problems };
}

/** Parse the hidden JSON the preview page carries into the apply step. */
export function claimsFromPayload(
  raw: string,
  knownChannelIds: ReadonlySet<string>,
): ClaimsInput | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length > MAX_CLAIMS) return null;
  const claims: ChannelClaim[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    const channelId = asString(o.channelId);
    const action = asString(o.action);
    if (!knownChannelIds.has(channelId) || !isAction(action)) return null;
    const bindKey = asString(o.bindKey);
    if (bindKey && !featureTarget(bindKey)) return null;
    const minGroupId = asString(o.minGroupId);
    claims.push({
      channelId,
      action,
      ...(bindKey ? { bindKey } : {}),
      roleIds: asList(o.roleIds),
      ...(minGroupId ? { minGroupId } : {}),
      allowReactions: o.allowReactions === true,
      lockReplies: o.lockReplies === true,
      approveReplace: o.approveReplace === true,
      voiceManagedOnly: o.voiceManagedOnly === true,
      usePrefix: o.usePrefix === true,
    });
  }
  return { claims, problems: [] };
}
