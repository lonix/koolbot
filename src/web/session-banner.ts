import { SESSION_LOW_MS } from "./app-shell.js";

/**
 * The session banner script (#367, #435, #1635), shared by the admin and the
 * `/me` layouts. Only the two paths differ: the read-only ping to poll and the
 * page to send the browser to when the session is over.
 */
export function sessionBannerScript(
  pingPath: string,
  signInPath: string,
): string {
  return (
    "(function(){var el=document.getElementById('session-countdown');if(!el)return;" +
    "function toMs(v){var n=Math.floor(Number(v));return isFinite(n)&&n>0?n:0}" +
    "var deadline=Date.now()+toMs(el.getAttribute('data-remaining-ms'));" +
    "var fired=false;" +
    `function expire(){if(fired)return;fired=true;window.location.href=${JSON.stringify(signInPath)}}` +
    "function tick(){var r=Math.max(0,deadline-Date.now());var s=Math.floor(r/1000);" +
    "var m=Math.floor(s/60);var ss=s%60;el.textContent=m+':'+(ss<10?'0'+ss:ss);" +
    `if(el.parentNode&&el.parentNode.classList)el.parentNode.classList.toggle('is-low',r<${SESSION_LOW_MS});` +
    "if(r<=0)expire()}" +
    "function applyRemaining(ms){deadline=Date.now()+toMs(ms);tick()}" +
    // A mouse move or key press is not a request: it does not extend the
    // session on the server, so it must not move the number on screen either.
    // It only makes the page look at the clock (an input event can arrive
    // before the interval timers after a long sleep).
    "function onActivity(){if(!fired)tick()}" +
    // The page woke up (tab shown again, restored from the back-forward
    // cache): check the clock and ask the server straight away.
    "function onWake(){if(fired)return;tick();poll()}" +
    "function poll(){if(fired)return;" +
    `fetch(${JSON.stringify(pingPath)},{credentials:'same-origin',headers:{'Accept':'application/json'},cache:'no-store'})` +
    ".then(function(res){if(res.status===401){expire();return null}" +
    "if(!res.ok)return null;return res.json()})" +
    ".then(function(data){if(!data)return;" +
    "if(typeof data.remainingMs==='number')applyRemaining(data.remainingMs)})" +
    ".catch(function(){})}" +
    "tick();poll();setInterval(tick,1000);setInterval(poll,30000);" +
    "document.addEventListener('mousemove',onActivity,{passive:true});" +
    "document.addEventListener('keydown',onActivity);" +
    "document.addEventListener('visibilitychange',function(){if(!document.hidden)onWake()});" +
    "window.addEventListener('pageshow',onWake)})();"
  );
}
