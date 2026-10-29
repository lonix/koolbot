/**
 * The Move up / Move down controls and the drag script of an ordered list
 * (#1540): Notices (within a category) and Presence (within a pool).
 *
 * Without JavaScript every row has a form of its own with two real buttons, and
 * a keyboard or screen-reader user uses those. The script only upgrades a mouse
 * drag: a drop puts the target place into the same form and submits it, so the
 * route, its stale-list check and its audit row are the ones the buttons use.
 */

import { escapeHtml } from "./html.js";
import { icon } from "./icons.js";

export interface ReorderCellOptions {
  /** Where the move form posts, for example `/admin/notices/<id>/move`. */
  action: string;
  /** The category or pool the row sits in; the server refuses the move when the row is stored elsewhere now. */
  scope: string;
  /** The hidden `_csrf` input. */
  csrfInput: string;
  /** 0-based place of the row now. */
  index: number;
  /** How many rows the list has. */
  count: number;
  /** What the row is called, for the button names ("Move up: Welcome"). */
  label: string;
}

/** Attributes for the row (`<tr>`) a {@link renderReorderCell} sits in. */
export function reorderRowAttrs(domId: string, label: string): string {
  return ` id="${escapeHtml(domId)}" data-reorder-row data-reorder-label="${escapeHtml(label)}"`;
}

/** Attribute for the `<tbody>` that holds one list; rows only move inside it. */
export function reorderListAttrs(groupLabel: string): string {
  return ` data-reorder-list data-reorder-group="${escapeHtml(groupLabel)}"`;
}

/** The handle, the place and the two buttons of one row, for its first cell. */
export function renderReorderCell(o: ReorderCellOptions): string {
  const name = escapeHtml(o.label);
  const move = (label: string, to: number, off: boolean): string =>
    `<button type="submit" name="to" value="${Math.max(to, 0)}" class="kb-btn kb-btn--sm"${off ? " disabled" : ""}>${label}<span class="kb-visually-hidden">: ${name}</span></button>`;
  return `<div class="kb-reorder">
<span class="kb-reorder__handle" data-reorder-handle>${icon("grip-vertical")}</span>
<span class="kb-reorder__place">${o.index + 1}<span class="kb-visually-hidden"> of ${o.count}</span></span>
<form method="POST" action="${escapeHtml(o.action)}" class="kb-reorder__form" data-reorder-form>${o.csrfInput}<input type="hidden" name="from" value="${o.index}"><input type="hidden" name="count" value="${o.count}"><input type="hidden" name="scope" value="${escapeHtml(o.scope)}">${move("Move up", o.index - 1, o.index === 0)}${move("Move down", o.index + 1, o.index >= o.count - 1)}</form>
</div>`;
}

/** The polite live region the drag script and a refused drop speak through. One per page. */
export const REORDER_STATUS_HTML = `<p class="kb-visually-hidden" id="reorder-status" role="status" aria-live="polite"></p>`;

/**
 * The page script: progressive enhancement only (see the file comment).
 * A row is dragged by its handle and dropped on another row of the same list.
 * A drop on another list, or in a browser that cannot `requestSubmit`, is read
 * out through the live region instead of doing anything.
 */
export const REORDER_SCRIPT = [
  "(function(){",
  "function say(m){var s=document.getElementById('reorder-status');if(s)s.textContent=m}",
  "if(typeof HTMLFormElement.prototype.requestSubmit!=='function')return;",
  "var rows=document.querySelectorAll('tr[data-reorder-row]'),dragged=null;",
  "function clear(){Array.prototype.forEach.call(document.querySelectorAll('tr.is-over'),function(r){r.classList.remove('is-over')})}",
  "function listOf(tr){return tr.closest('[data-reorder-list]')}",
  "Array.prototype.forEach.call(rows,function(tr){",
  "var h=tr.querySelector('[data-reorder-handle]');if(!h)return;",
  "tr.addEventListener('mousedown',function(e){if(e.target&&e.target.closest&&e.target.closest('[data-reorder-handle]'))tr.setAttribute('draggable','true');else tr.removeAttribute('draggable')});",
  "tr.addEventListener('mouseup',function(){tr.removeAttribute('draggable')});",
  "tr.addEventListener('dragstart',function(e){if(tr.getAttribute('draggable')!=='true'){e.preventDefault();return}",
  "dragged=tr;tr.classList.add('is-dragging');",
  "if(e.dataTransfer){e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',tr.getAttribute('data-reorder-label')||'')}catch(x){}}});",
  "tr.addEventListener('dragend',function(){tr.classList.remove('is-dragging');tr.removeAttribute('draggable');dragged=null;clear()});",
  "tr.addEventListener('dragover',function(e){if(!dragged||dragged===tr)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';clear();tr.classList.add('is-over')});",
  "tr.addEventListener('dragleave',function(e){if(!tr.contains(e.relatedTarget))tr.classList.remove('is-over')});",
  "tr.addEventListener('drop',function(e){if(!dragged)return;e.preventDefault();clear();",
  "var from=dragged;dragged=null;from.classList.remove('is-dragging');from.removeAttribute('draggable');if(from===tr)return;",
  "var who=from.getAttribute('data-reorder-label')||'This row',list=listOf(from);",
  "if(!list||listOf(tr)!==list){say(who+' can only be moved within '+(list&&list.getAttribute('data-reorder-group')||'its list')+'.');return}",
  "var all=Array.prototype.slice.call(list.querySelectorAll('tr[data-reorder-row]')),to=all.indexOf(tr),form=from.querySelector('form[data-reorder-form]');",
  "if(to<0||!form){say('Moving by drag is not available right now. Use the Move up and Move down buttons.');return}",
  "var old=form.querySelector('input[data-reorder-to]');if(old)form.removeChild(old);",
  "var inp=document.createElement('input');inp.type='hidden';inp.name='to';inp.value=String(to);inp.setAttribute('data-reorder-to','');form.appendChild(inp);",
  "say('Moving '+who+' to place '+(to+1)+' of '+all.length+'.');form.requestSubmit()})});",
  "})();",
].join("");
