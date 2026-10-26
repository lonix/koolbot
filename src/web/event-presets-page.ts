import type { Client } from "discord.js";
import { scriptTag } from "./html.js";
import { formView, type RefusedForm } from "./form-errors.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  GROUP_ROWS_HEAD,
  renderFlash,
  renderGroupRow,
  type FlashMessage,
} from "./admin-views.js";
import { ConfigService } from "../services/config-service.js";
import { EventService } from "../services/event-service.js";
import {
  deriveTagScript,
  groupBuilderScript,
  groupRowsScript,
  groupSetRowScript,
  markerColoursScript,
  renderGroupBuilder,
} from "./event-group-form.js";
import {
  catalogNotice,
  eventSetupToFormValues,
  loadPresetCatalog,
  MAX_LIBRARY_PRESETS,
  parseLibraryPresetId,
  PRESET_DESCRIPTION_MAX,
  PRESET_FORM_FIELDS,
  PRESET_GROUPS_FIELD,
  presetToFormValues,
  PRESET_LOBBY_FIELDS,
  type CatalogReadState,
  type PresetEntry,
} from "../services/event-group-preset-service.js";
import {
  listHostPresetsForAdmin,
  type HostPresetListing,
} from "../services/event-personal-preset-service.js";
import {
  copyGroupSetup,
  DEFAULT_GROUP_LABEL,
  DEFAULT_LEADER_LABEL,
  CHANNEL_LEAD_MAX,
  CHANNEL_LEAD_MIN,
  GROUP_FORM_FIELDS,
  GROUP_LABEL_MAX,
  GROUP_NAME_MAX,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  GROUP_TAG_MAX,
  groupRowField,
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
  /** The hosts' personal presets for the publish card (#1216); null = unreadable. */
  hostPresets?: HostPresetsView | null;
  /** The editor, when the last save was refused (#1523); `values` then holds what was typed. */
  refusedForm?: RefusedForm | null;
}

/** Form id of the preset editor (add or edit: there is one editor on the page) (#1523). */
export const EVENT_PRESET_FORM = "event-preset";

/** The hosts' personal presets, with a name to show for each owner. */
export interface HostPresetsView {
  rows: Array<HostPresetListing & { ownerName: string }>;
  /** Zero-based page shown, and whether a next page exists. */
  page: number;
  hasMore: boolean;
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
  hostPresets: HostPresetsView | null;
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
    hostPresets: await loadHostPresets(
      client,
      guildId,
      parseHostPage(query.hostPage),
    ),
    maxCount: limits.maxCount,
    defaultCount: limits.defaultCount,
    editing,
    editUnavailable,
    values,
    prefillNote,
  };
}

/** The card's page from `?hostPage=`: a small non-negative integer, else 0. */
function parseHostPage(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * The hosts' personal presets for the publish card. A display name comes from
 * the member cache only (no fetch per row); the id is shown next to it. A read
 * that fails yields null and the card says so.
 */
async function loadHostPresets(
  client: Client,
  guildId: string,
  page: number,
): Promise<HostPresetsView | null> {
  try {
    const { rows, hasMore } = await listHostPresetsForAdmin(guildId, page);
    const members = client.guilds?.cache?.get(guildId)?.members?.cache;
    return {
      page,
      hasMore,
      rows: rows.map((r) => ({
        ...r,
        ownerName: members?.get(r.ownerId)?.displayName ?? "",
      })),
    };
  } catch {
    return null;
  }
}

export function groupSummary(entry: PresetEntry): string {
  // The Captains lobby (a stored `leads` row) is a tag, not a listed group, as on
  // the event form and the host panel (#1263).
  const listed = entry.groups.filter((g) => g.kind !== "leads");
  const names = listed
    .map((g) => `${g.marker ? `${g.marker} ` : ""}${g.name}`)
    .join(", ");
  const tags = entry.tagsEnabled
    ? ' <span class="tag" title="Pre-ticks the clan tags box on the event form">clan tags on</span>'
    : "";
  const lobby =
    listed.length < entry.groups.length
      ? ' <span class="tag" title="Ticks Captains lobby on the event form (used while group leaders is ticked)">captains lobby</span>'
      : "";
  return `<span class="muted">${listed.length}:</span> ${escapeHtml(names)}${tags}${lobby}`;
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
export const EVENT_PRESETS_SCRIPT =
  "(function(){" +
  "var form=document.querySelector('form[data-preset-form]');if(!form)return;" +
  "var box=form.querySelector('[data-group-rows]');" +
  "var tpl=form.querySelector('template[data-group-row-template]');" +
  "var add=form.querySelector('[data-add-group]');" +
  "var max=parseInt(box.getAttribute('data-max'),10)||15;" +
  "var KEY='koolbot-event-preset-draft';" +
  "function rows(){return box.querySelectorAll('[data-group-row]')}" +
  // The Captains lobby is a channel too, so a ticked box counts toward the cap.
  "var lobby=form.elements['groups_captains_lobby'];" +
  // A leads row restored from an older draft is the lobby itself (the server
  // keeps one lobby, and none when the box is off), so it is not counted as a row.
  "function used(){var n=0;Array.prototype.forEach.call(rows(),function(r){var k=r.querySelector('select');if(!k||k.value!=='leads')n++});return n+(lobby&&lobby.checked?1:0)}" +
  // `force` is only for putting back rows that were submitted before (the cap
  // applies to a person adding rows, not to restoring what they had entered).
  "function addRow(force){var n=rows().length;if(used()>=max&&!force)return false;" +
  "var d=document.createElement('div');" +
  "d.innerHTML=tpl.innerHTML.replace(/__N__/g,String(n)).replace(/__P__/g,String(n+1));" +
  "var nr=d.firstElementChild;box.appendChild(nr);if(window.koolGroupRows)window.koolGroupRows.enhance(nr);recompute();return true}" +
  "recompute();if(add)add.addEventListener('click',function(){addRow()});" +
  // The tag follows the name (Red -> RED) while the clan tags box is ticked, until
  // it is edited by hand: the same rule as on the event form.
  deriveTagScript(GROUP_TAG_MAX) +
  "var tagsBox=form.elements['groups_tags'];" +
  // An emptied name clears its automatic tag whatever the box says (the server
  // would refuse a row with a tag and no name); only generating needs the box.
  "function deriveTags(){var on=tagsBox&&tagsBox.checked;Array.prototype.forEach.call(rows(),function(r){" +
  "var n=r.querySelector('input[name$=\"_name\"]'),t=r.querySelector('input[name$=\"_tag\"]');if(!n||!t)return;" +
  "if(t.hasAttribute('data-manual')||(t.value&&!t.hasAttribute('data-auto')))return;" +
  "var v=n.value.trim();if(v){if(on){t.value=derive(v);t.setAttribute('data-auto','1')}}else if(t.hasAttribute('data-auto')){t.value='';t.removeAttribute('data-auto')}})}" +
  // The Generate builder is the event form's own script (one copy in
  // event-group-form.ts): N groups of S, clamped to the cap, surplus rows
  // emptied, the tags derived by deriveTags above while Clan tags is ticked.
  `var MINSIZE=${GROUP_SIZE_MIN},MAXSIZE=${GROUP_SIZE_MAX},COLOURS=${markerColoursScript()};` +
  "function f(i,k){return form.elements['group_'+i+'_'+k]}" +
  "function val(n){var e=form.elements[n];return e?String(e.value||'').trim():''}" +
  "var builder=form.querySelector('[data-group-builder]');if(builder)builder.hidden=false;" +
  groupSetRowScript() +
  groupBuilderScript(
    "deriveTags();if(window.koolGroupRows)window.koolGroupRows.syncAll();recompute()",
  ) +
  ";" +
  "box.addEventListener('input',function(e){var t=e.target;if(!t||!t.name)return;" +
  "if(/_tag$/.test(t.name)){t.removeAttribute('data-auto');t.setAttribute('data-manual','1')}" +
  "else if(/_name$/.test(t.name))deriveTags()});" +
  "if(tagsBox)tagsBox.addEventListener('change',deriveTags);" +
  // One recompute for every change inside the form (the lobby box, a row's kind
  // such as a restored leads row). Code that sets a control by hand fires no
  // change event, so it calls the same recompute itself (the draft restore below).
  "function recompute(){if(add)add.hidden=used()>=max}" +
  "form.addEventListener('change',recompute);" +
  "form.addEventListener('submit',function(){try{var d={};" +
  "Array.prototype.forEach.call(form.elements,function(el){if(!el.name||el.name==='_csrf'||el.type==='button'||el.type==='submit')return;d[el.name]=el.type==='checkbox'?el.checked:el.value});" +
  // Which fields were filled in automatically or typed by hand travels with the
  // values, so a restored tag still follows the name (or stays as it was left).
  "['auto','manual'].forEach(function(a){d['__'+a]=[];Array.prototype.forEach.call(form.querySelectorAll('[data-'+a+']'),function(el){if(el.name)d['__'+a].push(el.name)})});" +
  "window.sessionStorage.setItem(KEY,JSON.stringify(d))}catch(x){}});" +
  "try{var raw=window.sessionStorage.getItem(KEY);window.sessionStorage.removeItem(KEY);" +
  "if(raw&&document.querySelector('.notice.err[data-flash]')){var d=JSON.parse(raw);" +
  "Object.keys(d).forEach(function(k){var m=/^group_(\\d+)_/.exec(k);if(m){var i=+m[1];while(rows().length<=i&&i<100)addRow(true)}});" +
  "Object.keys(d).forEach(function(k){if(k.indexOf('__')===0)return;var el=form.elements[k];if(!el)return;" +
  // A draft from before the tick can hold a leads row in a kind select, which
  // has no leads option now; it gets its option back so the retry keeps the row
  // instead of defaulting to a team, and the tick is set (it decides whether the
  // lobby is kept, and an older draft has no tick of its own).
  "if(el.tagName==='SELECT'&&/^group_\\d+_kind$/.test(k)&&d[k]==='leads'){var has=false;" +
  "Array.prototype.forEach.call(el.options,function(o){if(o.value==='leads')has=true});" +
  "if(!has){var lo=document.createElement('option');lo.value='leads';" +
  "lo.textContent='Leads (leaders and host only; use the Captains lobby tick instead)';el.appendChild(lo)}" +
  // Only when the draft has no tick of its own: an explicit false is the person
  // having unticked the box after an earlier restore, and stays unticked.
  "if(lobby&&typeof d['groups_captains_lobby']!=='boolean')lobby.checked=true}" +
  "if(k==='preset_id')return;if(el.type==='checkbox'){el.checked=d[k]===true;return}if(typeof d[k]==='string')el.value=d[k]});" +
  "['auto','manual'].forEach(function(a){(Array.isArray(d['__'+a])?d['__'+a]:[]).forEach(function(n){var el=form.elements[n];if(el&&el.setAttribute)el.setAttribute('data-'+a,'1')})});" +
  // Setting `checked` fires no change event: the button follows the restored box.
  "if(window.koolGroupRows)window.koolGroupRows.syncAll();recompute()}}catch(x){}" +
  "})();";

export interface PresetEditorFormProps {
  csrfInput: string;
  /** Where the form posts. */
  action: string;
  /** The preset being edited; null = adding a new one. */
  editing: { id: string; label: string } | null;
  editUnavailable?: boolean;
  /** Prefill, keyed by form field name. */
  values: Record<string, string>;
  maxCount: number;
  defaultCount: number;
  /** Where "Cancel" goes while editing. */
  cancelHref: string;
  /** Wording of the submit button when adding. */
  addLabel?: string;
  /** The editor, when the last save was refused (#1523); `values` then holds what was typed. */
  refusedForm?: RefusedForm | null;
}

/**
 * The preset editor form, shared by the admin library page and the host's own
 * presets page (#1216): the same fields, the same group rows, the same limits.
 * Everything dynamic goes through `escapeHtml`.
 */
export function renderPresetEditorForm(props: PresetEditorFormProps): string {
  const { csrfInput } = props;
  const v = props.values;
  const f = formView(props.refusedForm, EVENT_PRESET_FORM);
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
  const rowColumns = ["marker", "name", "size", "tag", "kind"] as const;
  const rows = Array.from({ length: rowCount }, (_, i) =>
    renderGroupRow(
      String(i),
      String(i + 1),
      prefilled[i],
      f.refused
        ? {
            attrs: Object.fromEntries(
              rowColumns.map((c) => [c, f.attrs(groupRowField(i, c))]),
            ),
            extra: rowColumns.map((c) => f.error(groupRowField(i, c))).join(""),
          }
        : undefined,
    ),
  ).join("\n      ");

  // The Captains lobby is a channel and counts toward the limit (the validator
  // counts it), so the notice does too.
  const lobbyOn = Boolean(v[GROUP_FORM_FIELDS.captainsLobby]);
  const total = prefilled.length + (lobbyOn ? 1 : 0);
  // What an older preset's lobby row held, carried so saving puts it back as it
  // was (see `PRESET_LOBBY_FIELDS`). Always rendered, empty when there is none,
  // so a restored draft has the fields to fill.
  const lobbyFields = Object.values(PRESET_LOBBY_FIELDS)
    .map(
      (name) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(v[name] ?? "")}">`,
    )
    .join("");
  const oversize =
    total > props.maxCount
      ? `<div class="notice warn" role="status">This setup has ${total} groups${lobbyOn ? " (counting the Captains lobby)" : ""} but the limit is ${props.maxCount} (<code>events.groups.max_count</code>). Remove groups, or raise the limit, before saving; nothing is dropped for you.</div>`
      : "";
  const editorHtml = props.editUnavailable
    ? '<div class="notice err" role="status">This preset cannot be loaded right now because the preset library could not be read. Nothing was changed. Reload the page in a moment to edit it.</div>'
    : `${oversize}
  <form method="POST" action="${escapeHtml(props.action)}" class="stack" data-preset-form>
    ${csrfInput}
    ${props.editing ? `<input type="hidden" name="${PRESET_FORM_FIELDS.id}" value="${escapeHtml(props.editing.id)}">` : ""}
    <label>Preset name (up to ${GROUP_NAME_MAX} characters, unique ignoring case)
      <input type="text" name="${PRESET_FORM_FIELDS.name}" required maxlength="${GROUP_NAME_MAX}" value="${escapeHtml(v[PRESET_FORM_FIELDS.name] ?? "")}" placeholder="Clan match"${f.attrs(PRESET_FORM_FIELDS.name)}>
    </label>${f.error(PRESET_FORM_FIELDS.name)}
    <label>Description (optional)
      <input type="text" name="${PRESET_FORM_FIELDS.description}" maxlength="${PRESET_DESCRIPTION_MAX}" value="${escapeHtml(v[PRESET_FORM_FIELDS.description] ?? "")}"${f.attrs(PRESET_FORM_FIELDS.description)}>
    </label>${f.error(PRESET_FORM_FIELDS.description)}
    <label>What a group is called (e.g. Team, Squad, Room, Party)
      <input type="text" name="${GROUP_FORM_FIELDS.label}" maxlength="${GROUP_LABEL_MAX}" value="${escapeHtml(v[GROUP_FORM_FIELDS.label] ?? "")}" placeholder="${DEFAULT_GROUP_LABEL}"${f.attrs(GROUP_FORM_FIELDS.label)}>
    </label>${f.error(GROUP_FORM_FIELDS.label)}
    <label>What a leader is called (e.g. Leader, Captain)
      <input type="text" name="${GROUP_FORM_FIELDS.leaderLabel}" maxlength="${GROUP_LABEL_MAX}" value="${escapeHtml(v[GROUP_FORM_FIELDS.leaderLabel] ?? "")}" placeholder="${DEFAULT_LEADER_LABEL}"${f.attrs(GROUP_FORM_FIELDS.leaderLabel)}>
    </label>${f.error(GROUP_FORM_FIELDS.leaderLabel)}
    <label>Create channels this many minutes before the start (empty = server default)
      <input type="number" name="${GROUP_FORM_FIELDS.leadMinutes}" min="${CHANNEL_LEAD_MIN}" max="${CHANNEL_LEAD_MAX}" value="${escapeHtml(v[GROUP_FORM_FIELDS.leadMinutes] ?? "")}" placeholder="Server default"${f.attrs(GROUP_FORM_FIELDS.leadMinutes)}>
    </label>${f.error(GROUP_FORM_FIELDS.leadMinutes)}
    <label class="checkbox"><input type="checkbox" name="${GROUP_FORM_FIELDS.tags}" value="1"${v[GROUP_FORM_FIELDS.tags] ? " checked" : ""}> Clan tags on nicknames: pre-tick this on the event form when the preset is chosen (the host can still change it for each event)</label>
    <p class="muted">Only teams that have a tag get one on their members' nicknames, while the event runs.</p>
    <label class="checkbox"><input type="checkbox" name="${GROUP_FORM_FIELDS.captainsLobby}" value="1"${lobbyOn ? " checked" : ""}> Captains lobby: a separate voice channel that only the host and the current leaders can join. Choosing this preset on the event form ticks Captains lobby there. It only takes effect on an event while group leaders is ticked (a preset has no leaders setting of its own); the host can still untick it for each event.</label>
    ${lobbyFields}
    ${renderGroupBuilder(props.maxCount)}${f.error(PRESET_GROUPS_FIELD)}
    ${GROUP_ROWS_HEAD}
    <div data-group-rows data-max="${props.maxCount}" class="stack">
      ${rows}
    </div>
    <template data-group-row-template>${renderGroupRow("__N__", "__P__")}</template>
    <button type="button" class="btn" data-add-group hidden>Add a group</button>
    <p class="muted">Up to ${props.maxCount} groups (<code>events.groups.max_count</code>). The Captains lobby counts as one of them. Rows left completely empty are ignored.</p>
    <button type="submit" class="btn btn-primary">${props.editing ? "Save changes" : (props.addLabel ?? "Add preset")}</button>
    ${props.editing ? `<a class="btn" href="${escapeHtml(props.cancelHref)}">Cancel</a>` : ""}
  </form>`;
  return editorHtml;
}

function hostPresetRow(
  row: HostPresetsView["rows"][number],
  csrfInput: string,
): string {
  const id = escapeHtml(row.entry.id);
  const published = row.publishedAs !== null;
  const owner = row.ownerName
    ? `${escapeHtml(row.ownerName)} <span class="muted">(${escapeHtml(row.ownerId)})</span>`
    : `<span class="mono">${escapeHtml(row.ownerId)}</span>`;
  const action = published
    ? `<form method="POST" action="/admin/events/presets/unpublish" class="inline" data-confirm="Remove the server copy of '${escapeHtml(row.entry.label)}'? Events that already used it keep their groups, and the host keeps their own preset.">${csrfInput}
    <input type="hidden" name="id" value="${id}">
    <button type="submit" class="btn btn-danger" aria-label="Unpublish ${escapeHtml(row.entry.label)}">Unpublish</button>
  </form>`
    : `<form method="POST" action="/admin/events/presets/publish" class="inline">${csrfInput}
    <input type="hidden" name="id" value="${id}">
    <button type="submit" class="btn" aria-label="Publish ${escapeHtml(row.entry.label)}">Publish</button>
  </form>`;
  return `<tr>
<td>${escapeHtml(row.entry.label)}${row.entry.description ? `<br><span class="muted">${escapeHtml(row.entry.description)}</span>` : ""}</td>
<td>${owner}</td>
<td>${groupSummary(row.entry)}</td>
<td>${published ? '<span class="tag tag-on">published</span>' : '<span class="tag tag-off">not published</span>'}</td>
<td class="actions">${action}</td>
</tr>`;
}

const HOST_PRESETS_INTRO =
  '<p class="muted">Hosts can save their own presets from the host panel. Only admins see them all. Publishing copies one into the server\'s presets above, switched on, so every host can pick it; the host keeps their own preset, and the copy stays if they later delete it or reset their data. Unpublishing deletes the server copy (including any change you made to it).</p>';

function hostPresetsPager(v: HostPresetsView): string {
  const link = (page: number, text: string): string =>
    `<a class="btn" href="/admin/events/presets?hostPage=${page}#host-presets">${text}</a>`;
  const parts = [
    v.page > 0 ? link(v.page - 1, "Previous") : "",
    v.hasMore ? link(v.page + 1, "Next") : "",
  ].filter(Boolean);
  return parts.length > 0
    ? `<p class="muted">Page ${v.page + 1}. ${parts.join(" ")}</p>`
    : "";
}

function renderHostPresetsCard(
  hostPresets: HostPresetsView | null | undefined,
  csrfInput: string,
): string {
  if (hostPresets === undefined) return "";
  if (hostPresets === null) {
    return `<div class="card" id="host-presets"><h2>Hosts' presets</h2>${HOST_PRESETS_INTRO}<div class="notice warn" role="status">The hosts' presets could not be read right now. Reload the page in a moment.</div></div>`;
  }
  if (hostPresets.rows.length === 0 && hostPresets.page === 0) {
    return `<div class="card" id="host-presets"><h2>Hosts' presets</h2>${HOST_PRESETS_INTRO}<p class="muted">No host has saved a preset yet.</p></div>`;
  }
  return `<div class="card" id="host-presets"><h2>Hosts' presets</h2>${HOST_PRESETS_INTRO}
<table class="data">
<thead><tr><th scope="col">Preset</th><th scope="col">Host</th><th scope="col">Groups</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
<tbody>${hostPresets.rows.map((r) => hostPresetRow(r, csrfInput)).join("\n")}</tbody>
</table>${hostPresetsPager(hostPresets)}</div>`;
}

export function renderEventPresetsPage(props: EventPresetsPageProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
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

  const editorHtml = renderPresetEditorForm({
    csrfInput,
    action: "/admin/events/presets/save",
    editing: props.editing,
    editUnavailable: props.editUnavailable,
    values: props.values,
    maxCount: props.maxCount,
    defaultCount: props.defaultCount,
    cancelHref: "/admin/events/presets",
    refusedForm: props.refusedForm,
  });
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
${renderHostPresetsCard(props.hostPresets, csrfInput)}
<div class="card" id="editor">
  <h2>${heading}</h2>
  ${props.prefillNote && !props.editUnavailable ? `<p class="muted">${escapeHtml(props.prefillNote)}</p>` : ""}
  ${editorHtml}
</div>
${scriptTag(groupRowsScript())}
${scriptTag(EVENT_PRESETS_SCRIPT)}
`;

  return renderAdminPage({
    title: "Group presets",
    active: "/admin/events/presets",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
