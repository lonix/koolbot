import { SESSION_LOW_MS } from "./app-shell.js";

/**
 * The two surfaces the banner runs on: the read-only ping to poll and the page
 * to send the browser to when the session is over. A fixed set, so no caller
 * can put an arbitrary string into the generated script.
 */
export const BANNER_SURFACES = {
  admin: { ping: "/admin/session/ping", signIn: "/admin/" },
  me: { ping: "/me/session/ping", signIn: "/me/" },
} as const;

export type BannerSurface = keyof typeof BANNER_SURFACES;

/**
 * The session banner script (#367, #435, #1635), shared by the admin and the
 * `/me` layouts. Only the two paths differ, and they come from
 * `BANNER_SURFACES`: an unknown surface throws, and the paths are written as
 * JSON string literals with `<` escaped, so they can neither end the string
 * nor close a surrounding `<script>` element.
 */
export function sessionBannerScript(surface: BannerSurface): string {
  if (!Object.prototype.hasOwnProperty.call(BANNER_SURFACES, surface)) {
    throw new Error(`Unknown session banner surface: ${String(surface)}`);
  }
  const literal = (v: string): string =>
    JSON.stringify(v).replace(/</g, "\\u003c");
  const pingPath = literal(BANNER_SURFACES[surface].ping);
  const signInPath = literal(BANNER_SURFACES[surface].signIn);
  return (
    "(function(){var el=document.getElementById('session-countdown');if(!el)return;" +
    "function toMs(v){var n=Math.floor(Number(v));return isFinite(n)&&n>0?n:0}" +
    "var deadline=Date.now()+toMs(el.getAttribute('data-remaining-ms'));" +
    "var fired=false;var checking=false;var lastCheck=0;var gen=0;var ctrl=null;" +
    `function go(){if(fired)return;fired=true;window.location.href=${signInPath}}` +
    // The local deadline is only a guess: another tab's request may have
    // renewed the session. So when it passes, the page asks the server (at
    // most once per 5 s while overdue) and leaves only on a 401 or when the
    // server itself reports no time left. A failed ping never navigates.
    // A ping that has not finished after 10 s (fetch or body) is given up, so
    // a stalled one cannot block every later check.
    "function tick(){var r=Math.max(0,deadline-Date.now());var s=Math.floor(r/1000);" +
    "var m=Math.floor(s/60);var ss=s%60;el.textContent=m+':'+(ss<10?'0'+ss:ss);" +
    `if(el.parentNode&&el.parentNode.classList)el.parentNode.classList.toggle('is-low',r<${SESSION_LOW_MS});` +
    "if(checking&&Math.abs(Date.now()-lastCheck)>=10000)cancel();" +
    "if(r<=0&&!fired&&!checking&&Math.abs(Date.now()-lastCheck)>=5000)poll()}" +
    // Abandon the ping in flight: its reply, if it ever comes, is obsolete.
    "function cancel(){gen++;checking=false;if(ctrl){try{ctrl.abort()}catch(e){}ctrl=null}}" +
    "function applyRemaining(ms,sentAt){deadline=sentAt+toMs(ms);tick()}" +
    // A mouse move or key press is not a request: it does not extend the
    // session on the server, so it must not move the number on screen either.
    // It only makes the page look at the clock (an input event can arrive
    // before the interval timers after a long sleep).
    "function onActivity(){if(!fired)tick()}" +
    // The page woke up (tab shown again, restored from the back-forward
    // cache): any ping from before the sleep is obsolete, so it is dropped
    // and a fresh one is sent, so tick() does not ask a second time.
    "function onWake(){if(fired)return;cancel();poll();tick()}" +
    // A reply counts only if it belongs to the latest ping (`my===gen`), and
    // its time is measured from when that ping was sent, never from when the
    // reply arrived.
    "function poll(){if(fired||checking)return;checking=true;var sentAt=Date.now();lastCheck=sentAt;var my=++gen;" +
    "var opts={credentials:'same-origin',headers:{'Accept':'application/json'},cache:'no-store'};" +
    "if(typeof AbortController==='function'){ctrl=new AbortController();opts.signal=ctrl.signal}" +
    `fetch(${pingPath},opts)` +
    ".then(function(res){if(my!==gen)return null;if(res.status===401){go();return null}" +
    "if(!res.ok)return null;return res.json()})" +
    ".then(function(data){if(my!==gen||!data||typeof data.remainingMs!=='number')return;" +
    "if(toMs(data.remainingMs)<=0){go();return}applyRemaining(data.remainingMs,sentAt)})" +
    ".catch(function(){})" +
    ".then(function(){if(my===gen){checking=false;ctrl=null}})}" +
    "tick();poll();setInterval(tick,1000);setInterval(poll,30000);" +
    "document.addEventListener('mousemove',onActivity,{passive:true});" +
    "document.addEventListener('keydown',onActivity);" +
    "document.addEventListener('visibilitychange',function(){if(!document.hidden)onWake()});" +
    "window.addEventListener('pageshow',onWake)})();"
  );
}
