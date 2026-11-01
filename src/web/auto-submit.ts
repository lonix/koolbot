/**
 * Auto-apply for a GET form whose only job is one switch (#1630).
 *
 * A form marked `data-autosubmit` is submitted as soon as one of its controls
 * changes, and its `[data-autosubmit-hide]` button (the one that carries the
 * form without JavaScript) is hidden. Without this script the page works the
 * same way through that button, so nothing depends on it. Only sent on a page
 * whose body contains `data-autosubmit` (`admin-layout.ts`).
 */
export const AUTO_SUBMIT_SCRIPT = [
  "(function(){",
  "document.querySelectorAll('form[data-autosubmit]').forEach(function(f){",
  "f.querySelectorAll('[data-autosubmit-hide]').forEach(function(b){b.hidden=true});",
  "f.addEventListener('change',function(){",
  "if(typeof f.requestSubmit==='function')f.requestSubmit();else f.submit()})})})();",
].join("");
