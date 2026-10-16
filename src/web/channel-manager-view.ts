import { renderAdminPage, type NavFeatureStatus } from "./admin-layout.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { escapeHtml } from "./html.js";
import type { RecentChange } from "./channel-manager-data.js";
import {
  CHANNEL_LIMITS,
  canMove,
  neighbourOf,
  type CategoryNode,
  type ChannelTree,
  type DeleteVerdict,
  type ManagedChannelView,
} from "./channel-manager.js";

/**
 * Channel Manager pages (#1065): the category/channel tree with create, edit,
 * reorder and delete controls, and the delete confirmation. Structure only;
 * permission overwrites are edited in Discord (or adopted from the Channel
 * Claims page). Always available to admins; there is no feature switch.
 */

export const CHANNELS_PATH = "/admin/channels";

export interface ChannelManagerProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** Null when the server couldn't be read. */
  channels: ManagedChannelView[] | null;
  tree: ChannelTree | null;
  /** Channel id -> why KoolBot manages it. Null when it couldn't be read. */
  protection: ReadonlyMap<string, string[]> | null;
  botCanManage: boolean;
  /** Latest `channels.*` web audit entries; null when unreadable. */
  recentChanges?: RecentChange[] | null;
  /** Bits per second. */
  maxBitrate: number;
  error?: string;
  flash?: FlashMessage | null;
}

const KIND_LABEL = { text: "Text", voice: "Voice", category: "Category" };

function csrfInput(token: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

function parentSelect(
  tree: ChannelTree,
  selected: string | null,
  label: string,
  disabled: boolean,
): string {
  const options = tree.categories
    .map(
      (n) =>
        `<option value="${escapeHtml(n.category.id)}"${n.category.id === selected ? " selected" : ""}>${escapeHtml(n.category.name)}</option>`,
    )
    .join("");
  return `<label>${escapeHtml(label)}
    <select name="parent"${disabled ? " disabled" : ""}><option value=""${selected === null ? " selected" : ""}>(no category)</option>${options}</select>
  </label>`;
}

function fieldRows(
  c: ManagedChannelView | null,
  p: ChannelManagerProps,
  tree: ChannelTree,
  off: string,
): string {
  const kind = c?.kind ?? null;
  // An existing bitrate above today's maximum (the server lost a boost level)
  // must stay inside the control's range, or the browser would block even an
  // unrelated edit. The server still validates any value that is changed.
  const maxKbps = Math.max(
    Math.floor(p.maxBitrate / 1000),
    c?.bitrate ? Math.round(c.bitrate / 1000) : 0,
  );
  const minKbps = CHANNEL_LIMITS.bitrateMin / 1000;
  const topic =
    kind === null || kind === "text"
      ? `<label>Topic${kind === null ? " (text channels only)" : ""}
      <textarea name="topic" rows="2" maxlength="${CHANNEL_LIMITS.topicMax}"${off}>${escapeHtml(c?.topic ?? "")}</textarea></label>`
      : "";
  const voice =
    kind === null || kind === "voice"
      ? `<label>User limit${kind === null ? " (voice only)" : ""}
      <input type="number" name="userLimit" min="0" max="${CHANNEL_LIMITS.userLimitMax}" value="${escapeHtml(c?.userLimit ?? "")}"${off}>
      <span class="muted">0 or empty means no limit</span></label>
    <label>Bitrate in kbps${kind === null ? " (voice only)" : ""}
      <input type="number" name="bitrate" min="${Math.min(minKbps, c?.bitrate ? Math.round(c.bitrate / 1000) : minKbps)}" max="${maxKbps}" value="${c?.bitrate ? escapeHtml(Math.round(c.bitrate / 1000)) : ""}"${off}>
      <span class="muted">${minKbps} to ${Math.floor(p.maxBitrate / 1000)}; empty keeps Discord's default</span></label>`
      : "";
  const parent =
    kind === "category"
      ? ""
      : parentSelect(tree, c?.parentId ?? null, "Category", off !== "");
  return `${topic}${voice}${parent}`;
}

/**
 * What the edit form displayed, as hidden fields. The edit handler writes only
 * fields the admin changed from these, and refuses the save when a field they
 * changed was altered elsewhere in the meantime.
 */
function baselineInputs(c: ManagedChannelView): string {
  const field = (name: string, value: string): string =>
    `<input type="hidden" name="orig_${name}" value="${escapeHtml(value)}">`;
  return [
    field("name", c.name),
    c.kind === "text" ? field("topic", c.topic ?? "") : "",
    c.kind === "voice" ? field("userLimit", String(c.userLimit ?? "")) : "",
    c.kind === "voice"
      ? field(
          "bitrate",
          c.bitrate ? String(Math.round(c.bitrate / 1000)) : "",
        ) + field("bitrate_bps", String(c.bitrate ?? ""))
      : "",
    c.kind === "category" ? "" : field("parent", c.parentId ?? ""),
  ].join("");
}

function protectionNote(c: ManagedChannelView, p: ChannelManagerProps): string {
  if (!p.protection) return "";
  const reasons = p.protection.get(c.id);
  if (!reasons || reasons.length === 0) return "";
  return `<div class="muted"><span class="tag tag-on">managed by KoolBot</span> ${escapeHtml(reasons.join("; "))}</div>`;
}

function describe(c: ManagedChannelView): string {
  const bits: string[] = [];
  if (c.kind === "text" && c.topic) bits.push(`topic: ${c.topic}`);
  if (c.kind === "voice") {
    bits.push(
      c.userLimit ? `limit ${c.userLimit}` : "no user limit",
      c.bitrate ? `${Math.round(c.bitrate / 1000)} kbps` : "",
    );
  }
  const text = bits.filter(Boolean).join(" · ");
  return text
    ? `<div class="muted">${escapeHtml(text.length > 160 ? `${text.slice(0, 160)}…` : text)}</div>`
    : "";
}

function actions(
  c: ManagedChannelView,
  p: ChannelManagerProps,
  tree: ChannelTree,
): string {
  const csrf = csrfInput(p.csrfToken);
  const off = p.botCanManage ? "" : " disabled";
  const id = escapeHtml(c.id);
  const name = escapeHtml(c.name);
  const all = p.channels ?? [];
  const move = (dir: "up" | "down", label: string): string =>
    `<form method="POST" action="${CHANNELS_PATH}/${id}/move" class="inline-form">${csrf}<input type="hidden" name="direction" value="${dir}"><input type="hidden" name="neighbor" value="${escapeHtml(neighbourOf(all, c, dir)?.id ?? "")}"><button type="submit" class="btn btn-sm"${canMove(all, c, dir) && p.botCanManage ? "" : " disabled"} aria-label="Move ${name} ${dir}">${label}</button></form>`;
  if (c.kind === "other") {
    return `<span class="muted">Not managed here (${escapeHtml(c.typeLabel)})</span>`;
  }
  const edit = `<details class="inline-edit"><summary>Edit</summary>
    <form method="POST" action="${CHANNELS_PATH}/${id}/edit" class="stack">${csrf}${baselineInputs(c)}
      <label>Name <input type="text" name="name" value="${name}" maxlength="${CHANNEL_LIMITS.nameMax}" required${off}></label>
      ${fieldRows(c, p, tree, off)}
      <button type="submit" class="btn btn-primary"${off}>Save changes</button>
    </form></details>`;
  const del = `<a class="btn btn-sm btn-danger" href="${CHANNELS_PATH}/${id}/delete" aria-label="Delete ${name}">Delete…</a>`;
  return `<div class="actions">${move("up", "Up")} ${move("down", "Down")} ${del}</div>${edit}`;
}

function channelRow(
  c: ManagedChannelView,
  p: ChannelManagerProps,
  tree: ChannelTree,
): string {
  const label = c.kind === "other" ? c.typeLabel : KIND_LABEL[c.kind];
  return `<tr>
<td><strong>${escapeHtml(c.name)}</strong>${describe(c)}${protectionNote(c, p)}</td>
<td>${escapeHtml(label)}</td>
<td>${actions(c, p, tree)}</td>
</tr>`;
}

function channelTable(
  rows: ManagedChannelView[],
  p: ChannelManagerProps,
  tree: ChannelTree,
): string {
  if (rows.length === 0) return `<div class="empty">No channels.</div>`;
  return `<table>
<thead><tr><th scope="col">Channel</th><th scope="col">Type</th><th scope="col">Actions</th></tr></thead>
<tbody>${rows.map((c) => channelRow(c, p, tree)).join("")}</tbody></table>`;
}

function categoryCard(
  n: CategoryNode,
  p: ChannelManagerProps,
  tree: ChannelTree,
): string {
  return `<div class="card">
  <h2>${escapeHtml(n.category.name)} <span class="tag">category</span></h2>
  ${protectionNote(n.category, p)}
  ${actions(n.category, p, tree)}
  ${channelTable(n.children, p, tree)}
</div>`;
}

function createCard(p: ChannelManagerProps, tree: ChannelTree): string {
  const off = p.botCanManage ? "" : " disabled";
  return `<div class="card">
  <h2>Create</h2>
  <form method="POST" action="${CHANNELS_PATH}/create" class="stack">${csrfInput(p.csrfToken)}
    <label>Type
      <select name="type"${off}>
        <option value="text">Text channel</option>
        <option value="voice">Voice channel</option>
        <option value="category">Category</option>
      </select>
    </label>
    <label>Name <input type="text" name="name" maxlength="${CHANNEL_LIMITS.nameMax}" required${off}></label>
    ${fieldRows(null, p, tree, off)}
    <p class="muted">A new channel gets no permission overrides of its own; set those in Discord. Categories ignore the topic, limit, bitrate and category fields.</p>
    <button type="submit" class="btn btn-primary"${off}>Create</button>
  </form>
</div>`;
}

function recentChangesCard(changes: RecentChange[] | null | undefined): string {
  if (changes === undefined) return "";
  if (changes === null) {
    return `<div class="card"><h2>Recent changes</h2><p class="muted">The audit log couldn't be read.</p></div>`;
  }
  if (changes.length === 0) {
    return `<div class="card"><h2>Recent changes</h2><p class="muted">No changes made through this page yet. Every change, including refused ones, is recorded here.</p></div>`;
  }
  const rows = changes
    .map(
      (c) => `<tr>
<td class="muted mono">${escapeHtml(c.at)}</td>
<td>${escapeHtml(c.action.replace(/^channels\./, ""))}</td>
<td>${escapeHtml(c.channelName ?? c.targetId ?? "")}</td>
<td><span class="tag ${c.result === "success" ? "tag-on" : "tag-off"}">${c.result === "success" ? "done" : "refused or failed"}</span>${c.message ? ` <span class="muted">${escapeHtml(c.message.length > 200 ? `${c.message.slice(0, 200)}…` : c.message)}</span>` : ""}</td>
<td class="muted mono">${escapeHtml(c.actorId)}</td>
</tr>`,
    )
    .join("");
  return `<div class="card">
  <h2>Recent changes</h2>
  <p class="muted">The latest entries of the web audit log for this page, newest first.</p>
  <table>
<thead><tr><th scope="col">When (UTC)</th><th scope="col">Action</th><th scope="col">Channel</th><th scope="col">Result</th><th scope="col">By</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
}

function layout(
  title: string,
  body: string,
  p: Pick<
    ChannelManagerProps,
    "csrfToken" | "remainingMs" | "navFeatureStatus"
  >,
): string {
  return renderAdminPage({
    title,
    active: CHANNELS_PATH,
    body,
    csrfToken: p.csrfToken,
    remainingMs: p.remainingMs,
    navFeatureStatus: p.navFeatureStatus,
  });
}

export function renderChannelManagerPage(p: ChannelManagerProps): string {
  const head = `<h1>Channel Manager</h1>
<p class="subtitle">Create, rename, reorder and delete the categories and text and voice channels on your server. Structure only: permissions are set in Discord.</p>
${renderFlash(p.flash)}`;
  const notices: string[] = [];
  if (p.error) {
    notices.push(
      `<div class="notice warn" role="status">${escapeHtml(p.error)}</div>`,
    );
  }
  if (!p.botCanManage) {
    notices.push(
      `<div class="notice warn" role="status"><strong>KoolBot doesn't have the Manage Channels permission.</strong> You can browse the structure, but every change is disabled until you grant it in Discord (Server Settings, Roles, KoolBot).</div>`,
    );
  }
  if (p.channels && p.protection === null) {
    notices.push(
      `<div class="notice warn" role="status">Which channels KoolBot manages couldn't be read. Deleting is refused until it can be.</div>`,
    );
  }
  const tree = p.tree;
  if (!tree) {
    return layout("Channel Manager", `${head}${notices.join("")}`, p);
  }
  const body = `${head}${notices.join("")}
<p class="muted">${tree.total} of ${CHANNEL_LIMITS.guildChannels} channels and categories used. Channels marked "managed by KoolBot" can't be deleted here.</p>
${createCard(p, tree)}
${
  tree.uncategorized.length > 0
    ? `<div class="card"><h2>No category</h2>${channelTable(tree.uncategorized, p, tree)}</div>`
    : ""
}
${tree.categories.map((n) => categoryCard(n, p, tree)).join("")}
${recentChangesCard(p.recentChanges)}`;
  return layout("Channel Manager", body, p);
}

export interface ChannelDeleteConfirmProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** Null when the channel no longer exists. */
  channel: ManagedChannelView | null;
  verdict: DeleteVerdict;
  /** `confirmationToken()` of the channel as shown on this page. */
  confirmToken: string;
  /** The bot lacks Manage Channels. */
  botCanManage: boolean;
}

export function renderChannelDeleteConfirmPage(
  p: ChannelDeleteConfirmProps,
): string {
  const back = `<a class="btn" href="${CHANNELS_PATH}">Back to the Channel Manager</a>`;
  let inner: string;
  if (!p.channel) {
    inner = `<div class="notice warn" role="status">That channel no longer exists.</div><div class="actions">${back}</div>`;
  } else if (!p.verdict.ok) {
    inner = `<div class="notice err" role="alert">${escapeHtml(p.verdict.message)}</div><div class="actions">${back}</div>`;
  } else if (!p.botCanManage) {
    inner = `<div class="notice warn" role="status">KoolBot doesn't have the Manage Channels permission, so it can't delete anything. Grant it in Discord first.</div><div class="actions">${back}</div>`;
  } else {
    const c = p.channel;
    const what =
      c.kind === "category"
        ? "this category"
        : c.kind === "voice"
          ? "this voice channel"
          : "this text channel";
    inner = `<div class="card">
  <h2>Delete ${escapeHtml(c.name)}?</h2>
  <p>You are about to permanently delete ${what}, <strong>${escapeHtml(c.name)}</strong>. ${c.kind === "text" ? "Its messages are deleted with it. " : ""}This can't be undone.</p>
  <form method="POST" action="${CHANNELS_PATH}/${escapeHtml(c.id)}/delete">
    ${csrfInput(p.csrfToken)}
    <input type="hidden" name="confirm" value="${escapeHtml(p.confirmToken)}">
    <div class="actions">
      <button type="submit" class="btn btn-danger">Delete permanently</button>
      <a class="btn" href="${CHANNELS_PATH}">Cancel</a>
    </div>
  </form>
</div>`;
  }
  return layout("Delete channel", `<h1>Delete channel</h1>${inner}`, p);
}
