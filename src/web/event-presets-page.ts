import type { Client } from "discord.js";
import { scriptTag } from "./html.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  renderFlash,
  renderGroupRow,
  type FlashMessage,
} from "./admin-views.js";
import { ConfigService } from "../services/config-service.js";
import { EventService } from "../services/event-service.js";
import {
  catalogNotice,
  eventSetupToFormValues,
  loadPresetCatalog,
  MAX_LIBRARY_PRESETS,
  parseLibraryPresetId,
  PRESET_DESCRIPTION_MAX,
  PRESET_FORM_FIELDS,
  presetToFormValues,
  type CatalogReadState,
  type PresetEntry,
} from "../services/event-group-preset-service.js";
import {
  copyGroupSetup,
  DEFAULT_GROUP_LABEL,
  DEFAULT_LEADER_LABEL,
  CHANNEL_LEAD_MAX,
  CHANNEL_LEAD_MIN,
  GROUP_FORM_FIELDS,
  GROUP_LABEL_MAX,
  GROUP_NAME_MAX,
  resolveGroupCountLimits,
} from "../services/event-groups.js";

/**
 * Event group presets admin page (#1200): `/admin/events/presets`. Lists the
 * built-in and the server's own presets with an on/off switch each, and holds
 * the editor for the server's own presets (create, edit, duplicate, and "save
 * an event's setup as a preset"). Presets are server-wide configuration, so
 * this is an admin Web UI page, not a slash command.
 */

export interface EventPresetsPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  flash?: FlashMessage | null;
  entries: PresetEntry[];
  state: CatalogReadState;
  maxCount: number;
  defaultCount: number;
  /** The library preset being edited; null = adding a new one. */
  editing: { id: string; label: string } | null;
  /**
   * An edit was requested for this preset id but its data could not be read
   * (the library is unreadable): the editor is replaced by a notice, so a blank
   * form cannot create a duplicate of the preset.
   */
  editUnavailable?: boolean;
  /** Prefill for the editor, keyed by form field name. */
  values: Record<string, string>;
  /** Why the editor is prefilled ("Copy of ..."), or null. */
  prefillNote: string | null;
}

export interface EventPresetsPageData {
  entries: PresetEntry[];
  state: CatalogReadState;
  maxCount: number;
  defaultCount: number;
  editing: { id: string; label: string } | null;
  editUnavailable: boolean;
  values: Record<string, string>;
  prefillNote: string | null;
}

/**
 * Read what the page shows: the catalog and, from the query string, the
 * editor's prefill (`edit=<id>`, `from=<id>`, `fromEvent=<event id>`).
 * Never throws for an unreadable library: the page says so instead.
 */
export async function loadEventPresetsPage(
  client: Client,
  guildId: string,
  query: Record<string, unknown>,
): Promise<EventPresetsPageData> {
  const config = ConfigService.getInstance();
  const [catalog, defaultCountRaw, maxCountRaw] = await Promise.all([
    loadPresetCatalog(guildId),
    config.getNumber("events.groups.default_count", 2),
    config.getNumber("events.groups.max_count", 15),
  ]);
  const limits = resolveGroupCountLimits(defaultCountRaw, maxCountRaw);
  const str = (name: string): string => {
    const raw = query[name];
    return typeof raw === "string" ? raw.trim() : "";
  };

  let editing: EventPresetsPageData["editing"] = null;
  let editUnavailable = false;
  let values: Record<string, string> = {};
  let prefillNote: string | null = null;

  const editId = str("edit");
  const fromId = str("from");
  const fromEventId = str("fromEvent");
  if (editId && parseLibraryPresetId(editId)) {
    const entry = catalog.entries.find((e) => e.id === editId);
    if (entry && entry.source === "library") {
      editing = { id: entry.id, label: entry.label };
      values = presetToFormValues(entry);
    } else if (catalog.state !== "ok") {
      // The library could not be read, so the preset cannot be shown. Do not
      // fall back to a blank add form: saving it would create a new preset.
      editUnavailable = true;
    } else {
      prefillNote =
        "That preset no longer exists. You can add a new one instead.";
    }
  } else if (fromId) {
    const entry = catalog.entries.find((e) => e.id === fromId);
    if (entry) {
      values = presetToFormValues({ ...entry, label: `${entry.label} (copy)` });
      prefillNote = `Prefilled from "${entry.label}". Give it a name and save to add it as your own preset.`;
    }
  } else if (fromEventId) {
    const event = await EventService.getInstance(client)
      .getEvent(fromEventId)
      .catch(() => null);
    if (event && event.guildId === guildId && event.groupsEnabled) {
      values = eventSetupToFormValues(copyGroupSetup(event));
      prefillNote = `Prefilled from the groups of the event "${event.title}". Give the preset a name and save it. The event itself is not changed.`;
    }
  }
  return {
    entries: catalog.entries,
    state: catalog.state,
    maxCount: limits.maxCount,
    defaultCount: limits.defaultCount,
    editing,
    editUnavailable,
    values,
    prefillNote,
  };
}

function groupSummary(entry: PresetEntry): string {
  const names = entry.groups
    .map((g) => `${g.marker ? `${g.marker} ` : ""}${g.name}`)
    .join(", ");
  return `<span class="muted">${entry.groups.length}:</span> ${escapeHtml(names)}`;
}

function entryRow(entry: PresetEntry, csrfInput: string): string {
  const library = entry.source === "library";
  const toggle = `<form method="POST" action="/admin/events/presets/toggle" class="inline">${csrfInput}
    <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
    <input type="hidden" name="enabled" value="${entry.enabled ? "0" : "1"}">
    <button type="submit" class="btn" aria-label="${entry.enabled ? "Turn off" : "Turn on"} ${escapeHtml(entry.label)}">${entry.enabled ? "Turn off" : "Turn on"}</button>
  </form>`;
  const duplicate = `<a class="btn" href="/admin/events/presets?from=${encodeURIComponent(entry.id)}#editor" aria-label="Duplicate ${escapeHtml(entry.label)}">Duplicate</a>`;
  const edit = library
    ? `<a class="btn" href="/admin/events/presets?edit=${encodeURIComponent(entry.id)}#editor" aria-label="Edit ${escapeHtml(entry.label)}">Edit</a>
  <form method="POST" action="/admin/events/presets/delete" class="inline" data-confirm="Delete the preset '${escapeHtml(entry.label)}'? Events that already used it keep their groups.">${csrfInput}
    <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
    <button type="submit" class="btn btn-danger" aria-label="Delete ${escapeHtml(entry.label)}">Delete</button>
  </form>`
    : "";
  return `<tr>
<td>${escapeHtml(entry.label)}${entry.description ? `<br><span class="muted">${escapeHtml(entry.description)}</span>` : ""}</td>
<td>${library ? "Your preset" : "Built-in"}</td>
<td>${groupSummary(entry)}</td>
<td><span class="tag ${entry.enabled ? "tag-on" : "tag-off"}">${entry.enabled ? "on" : "off"}</span></td>
<td class="actions">${toggle} ${duplicate} ${edit}</td>
</tr>`;
}

// Progressive enhancement: "Add a group" clones the row template, and the
// entered values survive a refused save (this tab's sessionStorage only; a
// convenience, so every storage call is guarded).
const EVENT_PRESETS_SCRIPT =
  "(function(){" +
  "var form=document.querySelector('form[data-preset-form]');if(!form)return;" +
  "var box=form.querySelector('[data-group-rows]');" +
  "var tpl=form.querySelector('template[data-group-row-template]');" +
  "var add=form.querySelector('[data-add-group]');" +
  "var max=parseInt(box.getAttribute('data-max'),10)||15;" +
  "var KEY='koolbot-event-preset-draft';" +
  "function rows(){return box.querySelectorAll('[data-group-row]')}" +
  "function addRow(){var n=rows().length;if(n>=max)return false;" +
  "var d=document.createElement('div');" +
  "d.innerHTML=tpl.innerHTML.replace(/__N__/g,String(n)).replace(/__P__/g,String(n+1));" +
  "box.appendChild(d.firstElementChild);if(add)add.hidden=rows().length>=max;return true}" +
  "if(add){add.hidden=rows().length>=max;add.addEventListener('click',function(){addRow()})}" +
  "form.addEventListener('submit',function(){try{var d={};" +
  "Array.prototype.forEach.call(form.elements,function(el){if(!el.name||el.name==='_csrf'||el.type==='button'||el.type==='submit')return;d[el.name]=el.value});" +
  "window.sessionStorage.setItem(KEY,JSON.stringify(d))}catch(x){}});" +
  "try{var raw=window.sessionStorage.getItem(KEY);window.sessionStorage.removeItem(KEY);" +
  "if(raw&&document.querySelector('.notice.err[data-flash]')){var d=JSON.parse(raw);" +
  "Object.keys(d).forEach(function(k){var m=/^group_(\\d+)_/.exec(k);if(m){var i=+m[1];while(rows().length<=i){if(!addRow())return}}});" +
  "Object.keys(d).forEach(function(k){var el=form.elements[k];if(!el||typeof d[k]!=='string')return;" +
  "if(k==='preset_id')return;el.value=d[k]})}}catch(x){}" +
  "})();";

export function renderEventPresetsPage(props: EventPresetsPageProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const v = props.values;
  const notice = catalogNotice(props.state);

  const libraryCount = props.entries.filter(
    (e) => e.source === "library",
  ).length;
  const table =
    props.entries.length > 0
      ? `<table class="data">
<thead><tr><th scope="col">Preset</th><th scope="col">Kind</th><th scope="col">Groups</th><th scope="col">Offered to hosts</th><th scope="col">Actions</th></tr></thead>
<tbody>${props.entries.map((e) => entryRow(e, csrfInput)).join("\n")}</tbody>
</table>`
      : '<p class="muted">The presets could not be listed.</p>';

  // Rows to render: the prefilled groups, else the configured default count.
  const prefilled: Array<Record<string, string>> = [];
  // Every stored row is shown, even beyond the cap: the validator refuses an
  // oversized setup until groups are removed on purpose, so a lowered
  // events.groups.max_count never silently drops groups from a saved preset.
  for (let i = 0; i < 100; i++) {
    if (v[`group_${i}_name`] === undefined) break;
    prefilled.push({
      name: v[`group_${i}_name`] ?? "",
      kind: v[`group_${i}_kind`] ?? "team",
      size: v[`group_${i}_size`] ?? "",
      tag: v[`group_${i}_tag`] ?? "",
      marker: v[`group_${i}_marker`] ?? "",
    });
  }
  const rowCount = Math.max(prefilled.length, props.defaultCount);
  const rows = Array.from({ length: rowCount }, (_, i) =>
    renderGroupRow(String(i), String(i + 1), prefilled[i]),
  ).join("\n      ");

  const oversize =
    prefilled.length > props.maxCount
      ? `<div class="notice warn" role="status">This setup has ${prefilled.length} groups but the limit is ${props.maxCount} (<code>events.groups.max_count</code>). Remove groups, or raise the limit, before saving; nothing is dropped for you.</div>`
      : "";
  const editorHtml = props.editUnavailable
    ? '<div class="notice err" role="status">This preset cannot be loaded right now because the preset library could not be read. Nothing was changed. Reload the page in a moment to edit it.</div>'
    : `${oversize}
  <form method="POST" action="/admin/events/presets/save" class="stack" data-preset-form>
    ${csrfInput}
    ${props.editing ? `<input type="hidden" name="${PRESET_FORM_FIELDS.id}" value="${escapeHtml(props.editing.id)}">` : ""}
    <label>Preset name (up to ${GROUP_NAME_MAX} characters, unique ignoring case)
      <input type="text" name="${PRESET_FORM_FIELDS.name}" required maxlength="${GROUP_NAME_MAX}" value="${escapeHtml(v[PRESET_FORM_FIELDS.name] ?? "")}" placeholder="Clan match">
    </label>
    <label>Description (optional)
      <input type="text" name="${PRESET_FORM_FIELDS.description}" maxlength="${PRESET_DESCRIPTION_MAX}" value="${escapeHtml(v[PRESET_FORM_FIELDS.description] ?? "")}">
    </label>
    <label>What a group is called (e.g. Team, Squad, Room, Party)
      <input type="text" name="${GROUP_FORM_FIELDS.label}" maxlength="${GROUP_LABEL_MAX}" value="${escapeHtml(v[GROUP_FORM_FIELDS.label] ?? "")}" placeholder="${DEFAULT_GROUP_LABEL}">
    </label>
    <label>What a leader is called (e.g. Leader, Captain)
      <input type="text" name="${GROUP_FORM_FIELDS.leaderLabel}" maxlength="${GROUP_LABEL_MAX}" value="${escapeHtml(v[GROUP_FORM_FIELDS.leaderLabel] ?? "")}" placeholder="${DEFAULT_LEADER_LABEL}">
    </label>
    <label>Create channels this many minutes before the start (empty = server default)
      <input type="number" name="${GROUP_FORM_FIELDS.leadMinutes}" min="${CHANNEL_LEAD_MIN}" max="${CHANNEL_LEAD_MAX}" value="${escapeHtml(v[GROUP_FORM_FIELDS.leadMinutes] ?? "")}" placeholder="Server default">
    </label>
    <div data-group-rows data-max="${props.maxCount}" class="stack">
      ${rows}
    </div>
    <template data-group-row-template>${renderGroupRow("__N__", "__P__")}</template>
    <button type="button" class="btn" data-add-group hidden>Add a group</button>
    <p class="muted">Up to ${props.maxCount} groups (<code>events.groups.max_count</code>), at most one of kind Leads. Rows left completely empty are ignored.</p>
    <button type="submit" class="btn btn-primary">${props.editing ? "Save changes" : "Add preset"}</button>
    ${props.editing ? '<a class="btn" href="/admin/events/presets">Cancel</a>' : ""}
  </form>`;

  const heading = props.editing
    ? `Edit "${escapeHtml(props.editing.label)}"`
    : "Add a preset";
  const body = `
<h1>Group presets</h1>
<p class="subtitle">Presets fill in the groups of an event in one click. Built-in presets can be switched off but not edited; add your own below. Changing, switching off or deleting a preset never changes events that already used it: each event keeps its own copy of its groups. <a href="/admin/events">Back to Events</a>.</p>
${renderFlash(props.flash)}
${notice ? `<div class="notice warn" role="status">${escapeHtml(notice)}</div>` : ""}
<div class="card">
  <h2>Presets</h2>
  ${table}
  <p class="muted">Turning a preset off hides it from the event form. The "Custom" choice is always available. Your presets: ${libraryCount} of ${MAX_LIBRARY_PRESETS}.</p>
</div>
<div class="card" id="editor">
  <h2>${heading}</h2>
  ${props.prefillNote && !props.editUnavailable ? `<p class="muted">${escapeHtml(props.prefillNote)}</p>` : ""}
  ${editorHtml}
</div>
${scriptTag(EVENT_PRESETS_SCRIPT)}
`;

  return renderAdminPage({
    title: "Group presets",
    active: "/admin/events",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
