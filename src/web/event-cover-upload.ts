/**
 * What the admin Events page and the host's edit page share for the event cover
 * upload (#1181, #1393): the raw-body parser of the upload routes and the page
 * script that sends the chosen file. Storage, size and signature checks live in
 * `services/event-cover.ts`; the routes only call them.
 */

import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { COVER_MAX_BYTES } from "../services/event-cover.js";

/**
 * Parses the file's raw bytes (not multipart, and not through the 256 KB
 * urlencoded parser the router mounts globally); the CSRF token travels in
 * `X-CSRF-Token`. Mount it inside a router, after its session, role and CSRF
 * checks, so a body is only read for a request that passed them. `onTooLarge`
 * answers a 413; any other parse error goes to `next`.
 */
export function coverUploadBody(
  onTooLarge: (req: Request, res: Response) => void,
): RequestHandler {
  const raw = express.raw({
    type: "application/octet-stream",
    limit: COVER_MAX_BYTES,
  });
  return (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const status = (err as { status?: number } | null)?.status;
      if (status === 413) {
        onTooLarge(req, res);
        return;
      }
      next(err);
    });
  };
}

export const COVER_TOO_LARGE_TEXT = `The image is too large. The maximum is ${COVER_MAX_BYTES / (1024 * 1024)} MB.`;

// Cover upload (#1181). The router has no multipart parser (and its urlencoded
// parser stops at 256 KB), so the chosen file's raw bytes are POSTed with fetch
// to the event's cover route (the admin Events page and the host's edit page, #1393), with the CSRF token in a header. The server
// answers with the usual JSON flash plus a `reload` URL, which is followed so
// the result shows as a flash (only for a saved cover: a rejected one is shown
// next to the control, so a half-edited form on the page is not thrown away);
// before the upload, a changed event-edit form asks first; a failure before that (CSRF, network) is shown
// next to the control. The size is checked here first only to spare the upload;
// the server checks size and the real file signature again.
export const EVENT_COVER_UPLOAD_SCRIPT =
  "(function(){" +
  "var edit=document.querySelector('[data-event-edit-form]');" +
  "function dirty(){if(!edit)return false;var els=edit.elements;" +
  "for(var i=0;i<els.length;i++){var el=els[i],t=(el.type||'').toLowerCase();" +
  "if(t==='hidden'||t==='submit'||t==='button'||t==='file')continue;" +
  "if(t==='checkbox'||t==='radio'){if(el.checked!==el.defaultChecked)return true;continue}" +
  "if(el.tagName==='SELECT'){for(var j=0;j<el.options.length;j++){if(el.options[j].selected!==el.options[j].defaultSelected)return true}continue}" +
  "if(el.value!==el.defaultValue)return true}return false}" +
  "function leave(){return !dirty()||window.confirm('You have unsaved changes to the event details. Changing the cover reloads this page and discards them. Continue?')}" +
  "var removes=document.querySelectorAll('form[data-cover-remove]');" +
  "Array.prototype.forEach.call(removes,function(f){f.addEventListener('submit',function(e){if(!leave()){e.preventDefault();e.stopImmediatePropagation()}})});" +
  "var forms=document.querySelectorAll('form[data-cover-upload]');" +
  "Array.prototype.forEach.call(forms,function(form){" +
  "var file=form.querySelector('input[type=file]');" +
  "var msg=form.querySelector('.cover-msg');" +
  "var btn=form.querySelector('button[type=submit]');" +
  "var tok=form.querySelector('input[name=_csrf]');" +
  "var max=parseInt(form.getAttribute('data-max-bytes'),10)||0;" +
  "function note(t){if(msg)msg.textContent=t}" +
  "form.addEventListener('submit',function(e){" +
  "e.preventDefault();" +
  "var f=file&&file.files&&file.files[0];" +
  "if(!f){note('Choose an image first.');return}" +
  "if(max&&f.size>max){note('That file is too large (max '+Math.floor(max/1048576)+' MB).');return}" +
  "if(typeof fetch!=='function'){note('This browser cannot upload the image.');return}" +
  "if(!leave())return;" +
  "if(btn)btn.disabled=true;note('Uploading\\u2026');" +
  "fetch(form.getAttribute('action'),{method:'POST',credentials:'same-origin',cache:'no-store'," +
  "headers:{'Content-Type':'application/octet-stream','Accept':'application/json'," +
  "'X-Requested-With':'fetch','X-CSRF-Token':tok?tok.value:''},body:f})" +
  ".then(function(res){var status=res.status;return res.text().then(function(t){" +
  "var d=null;try{d=JSON.parse(t)}catch(x){}return{status:status,json:d}})})" +
  ".then(function(r){if(btn)btn.disabled=false;var d=r.json;" +
  "if(d&&d.type==='ok'&&typeof d.reload==='string'&&(d.reload.indexOf('/admin/')===0||d.reload.indexOf('/me/')===0)&&d.reload.indexOf('//')<0){window.location.assign(d.reload);return}" +
  "note(d&&typeof d.text==='string'&&d.text?d.text:'Upload failed ('+r.status+').')})" +
  ".catch(function(){if(btn)btn.disabled=false;note('Upload failed. Check your connection and try again.')})" +
  "})})})();";
