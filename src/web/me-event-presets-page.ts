import { escapeHtml, scriptTag } from "./html.js";
import { groupRowsScript } from "./event-group-form.js";
import {
  EVENT_PRESETS_SCRIPT,
  groupSummary,
  renderPresetEditorForm,
} from "./event-presets-page.js";
import {
  MAX_PERSONAL_PRESETS,
  type PresetEntry,
} from "../services/event-group-preset-service.js";

/**
 * "My event presets" (#1216): `/me/events/presets`, where a host lists, edits,
 * saves and deletes their own group presets. The editor is the admin library's
 * (`renderPresetEditorForm`), so the same fields and limits apply. A host only
 * ever sees their own presets here.
 */

export interface MyEventPresetsPageProps {
  csrfToken: string;
  /** The host's presets; null = they could not be read. */
  presets: PresetEntry[] | null;
  /** The preset being edited; null = adding a new one. */
  editing: { id: string; label: string } | null;
  /** The edit target could not be shown (the read failed). */
  editUnavailable: boolean;
  values: Record<string, string>;
  prefillNote: string | null;
  maxCount: number;
  defaultCount: number;
}

// The shared editor form uses `stack`, which the member layout does not style.
const EDITOR_STYLE =
  "<style>form.stack label{display:block;margin:0 0 .75rem}form.stack input[type=text],form.stack input[type=number],form.stack select{display:block;max-width:100%}form.stack fieldset{margin:0 0 .75rem}form.inline{display:inline}</style>";

function presetRow(entry: PresetEntry, csrfInput: string): string {
  const id = encodeURIComponent(entry.id);
  return `<tr>
<td>${escapeHtml(entry.label)}${entry.description ? `<br><span class="muted">${escapeHtml(entry.description)}</span>` : ""}</td>
<td>${groupSummary(entry)}</td>
<td class="actions"><a class="btn" href="/me/events/presets?edit=${id}#editor" aria-label="Edit ${escapeHtml(entry.label)}">Edit</a>
<form method="POST" action="/me/events/presets/delete" class="inline" data-confirm="Delete your preset '${escapeHtml(entry.label)}'? Events that already used it keep their groups. A copy an admin published to the server library stays.">${csrfInput}
<input type="hidden" name="id" value="${escapeHtml(entry.id)}">
<button type="submit" class="btn btn-danger" aria-label="Delete ${escapeHtml(entry.label)}">Delete</button>
</form></td>
</tr>`;
}

export function renderMyEventPresetsBody(
  props: MyEventPresetsPageProps,
): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const list =
    props.presets === null
      ? '<div class="notice warn" role="status">Your presets could not be read right now. Reload the page in a moment.</div>'
      : props.presets.length === 0
        ? '<p class="muted">You have no presets yet. Save the groups of an event from its host panel, or add one below.</p>'
        : `<table class="prefs-table">
<thead><tr><th scope="col">Preset</th><th scope="col">Groups</th><th scope="col">Actions</th></tr></thead>
<tbody>${props.presets.map((p) => presetRow(p, csrfInput)).join("\n")}</tbody>
</table>`;
  const count =
    props.presets === null
      ? ""
      : `<p class="muted">Your presets: ${props.presets.length} of ${MAX_PERSONAL_PRESETS}.</p>`;
  const editor = renderPresetEditorForm({
    csrfInput,
    action: "/me/events/presets/save",
    editing: props.editing,
    editUnavailable: props.editUnavailable,
    values: props.values,
    maxCount: props.maxCount,
    defaultCount: props.defaultCount,
    cancelHref: "/me/events/presets",
    addLabel: "Save preset",
  });
  const heading = props.editing
    ? `Edit "${escapeHtml(props.editing.label)}"`
    : "Add a preset";
  return `${EDITOR_STYLE}<h1>My event presets</h1>
<p class="subtitle">Presets fill in the groups of an event in one click. These are yours: other hosts cannot see or use them. Server admins can see them (the admin needs that to publish one) and may publish one to the server's presets, which makes a copy for everyone while your own preset stays. Changing or deleting a preset never changes events that already used it. <a href="/me/">Back to overview</a></p>
<div class="card">
  <h2>Your presets</h2>
  ${list}
  ${count}
</div>
<div class="card" id="editor">
  <h2>${heading}</h2>
  ${props.prefillNote && !props.editUnavailable ? `<p class="muted">${escapeHtml(props.prefillNote)}</p>` : ""}
  ${editor}
</div>
${scriptTag(groupRowsScript())}
${scriptTag(EVENT_PRESETS_SCRIPT)}`;
}
