/**
 * Shared icon helper for the Web UI (#1369).
 *
 * Lucide icons (ISC licence, lucide-static 1.61.0; the Lucide and Feather
 * notices are in THIRD_PARTY_NOTICES.md), copied and inlined, never
 * loaded from a CDN. Each entry is the children of a 24x24 `svg`; the
 * `kb-icon` class draws it (16px, `kb-icon--lg` 20px, `currentColor`).
 * The names are those DESIGN.md > Iconography lists, plus the few the views
 * already used. `__tests__/web/icons.test.ts` fails when DESIGN.md lists a
 * name that is missing here.
 */

import { escapeHtml } from "./html.js";

export const ICONS = {
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  "arrow-right-left":
    '<path d="m16 3 4 4-4 4"/>' +
    '<path d="M20 7H4"/>' +
    '<path d="m8 21-4-4 4-4"/>' +
    '<path d="M4 17h16"/>',
  "audio-lines":
    '<path d="M2 10v3"/>' +
    '<path d="M6 6v11"/>' +
    '<path d="M10 3v18"/>' +
    '<path d="M14 8v7"/>' +
    '<path d="M18 5v13"/>' +
    '<path d="M22 10v3"/>',
  bell:
    '<path d="M10.268 21a2 2 0 0 0 3.464 0"/>' +
    '<path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  "book-open":
    '<path d="M12 5v16"/>' +
    '<path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
  cake:
    '<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/>' +
    '<path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/>' +
    '<path d="M2 21h20"/>' +
    '<path d="M7 8v3"/>' +
    '<path d="M12 8v3"/>' +
    '<path d="M17 8v3"/>' +
    '<path d="M7 4h.01"/>' +
    '<path d="M12 4h.01"/>' +
    '<path d="M17 4h.01"/>',
  calendar:
    '<path d="M8 2v3"/>' +
    '<path d="M16 2v3"/>' +
    '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
    '<path d="M3 9h18"/>',
  "calendar-plus":
    '<path d="M16 18h6"/>' +
    '<path d="M16 2v3"/>' +
    '<path d="M19 15v6"/>' +
    '<path d="M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3"/>' +
    '<path d="M3 9h18"/>' +
    '<path d="M8 2v3"/>',
  "chart-column":
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/>' +
    '<path d="M18 17V9"/>' +
    '<path d="M13 17V5"/>' +
    '<path d="M8 17v-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "circle-check":
    '<circle cx="12" cy="12" r="10"/>' + '<path d="m16 9-5.5 5.5L8 12"/>',
  "circle-x":
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="m15 9-6 6"/>' +
    '<path d="m9 9 6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/>' + '<path d="M12 6v6l4 2"/>',
  crown:
    '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/>' +
    '<path d="M5 21h14"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/>' +
    '<path d="M3 5V19A9 3 0 0 0 21 19V5"/>' +
    '<path d="M3 12A9 3 0 0 0 21 12"/>',
  ellipsis:
    '<circle cx="12" cy="12" r="1"/>' +
    '<circle cx="19" cy="12" r="1"/>' +
    '<circle cx="5" cy="12" r="1"/>',
  "external-link":
    '<path d="M15 3h6v6"/>' +
    '<path d="M10 14 21 3"/>' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
  "folder-tree":
    '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/>' +
    '<path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/>' +
    '<path d="M3 5a2 2 0 0 0 2 2h3"/>' +
    '<path d="M3 3v13a2 2 0 0 0 2 2h3"/>',
  "gamepad-2":
    '<line x1="6" x2="10" y1="11" y2="11"/>' +
    '<line x1="8" x2="8" y1="9" y2="13"/>' +
    '<line x1="15" x2="15.01" y1="12" y2="12"/>' +
    '<line x1="18" x2="18.01" y1="10" y2="10"/>' +
    '<path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  gavel:
    '<path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3l8.384-8.381"/>' +
    '<path d="m16 16 6-6"/>' +
    '<path d="m21.5 10.5-8-8"/>' +
    '<path d="m8 8 6-6"/>' +
    '<path d="m8.5 7.5 8 8"/>',
  "grip-vertical":
    '<circle cx="9" cy="12" r="1"/>' +
    '<circle cx="9" cy="5" r="1"/>' +
    '<circle cx="9" cy="19" r="1"/>' +
    '<circle cx="15" cy="12" r="1"/>' +
    '<circle cx="15" cy="5" r="1"/>' +
    '<circle cx="15" cy="19" r="1"/>',
  hash:
    '<line x1="4" x2="20" y1="9" y2="9"/>' +
    '<line x1="4" x2="20" y1="15" y2="15"/>' +
    '<line x1="10" x2="8" y1="3" y2="21"/>' +
    '<line x1="16" x2="14" y1="3" y2="21"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/>' +
    '<path d="M12 7v5l4 2"/>',
  info:
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="M12 16v-4"/>' +
    '<path d="M12 8h.01"/>',
  "key-round":
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
    '<circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  "layout-dashboard":
    '<rect width="7" height="9" x="3" y="3" rx="1"/>' +
    '<rect width="7" height="5" x="14" y="3" rx="1"/>' +
    '<rect width="7" height="9" x="14" y="12" rx="1"/>' +
    '<rect width="7" height="5" x="3" y="16" rx="1"/>',
  lock:
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
    '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  "lock-open":
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
    '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  "log-out":
    '<path d="m16 17 5-5-5-5"/>' +
    '<path d="M21 12H9"/>' +
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  megaphone:
    '<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>' +
    '<path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/>' +
    '<path d="M8 6v8"/>',
  mic:
    '<path d="M12 19v3"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
    '<rect x="9" y="2" width="6" height="13" rx="3"/>',
  minus: '<path d="M5 12h14"/>',
  newspaper:
    '<path d="M15 18h-5"/>' +
    '<path d="M18 14h-8"/>' +
    '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"/>' +
    '<rect width="8" height="4" x="10" y="6" rx="1"/>',
  plus: '<path d="M5 12h14"/>' + '<path d="M12 5v14"/>',
  quote:
    '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>' +
    '<path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>' +
    '<path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>' +
    '<path d="M8 16H3v5"/>',
  "rotate-ccw":
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/>',
  "scan-search":
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>' +
    '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
    '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>' +
    '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="m16 16-1.9-1.9"/>',
  "scroll-text":
    '<path d="M15 12h-5"/>' +
    '<path d="M15 8h-5"/>' +
    '<path d="M19 17V5a2 2 0 0 0-2-2H4"/>' +
    '<path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/>' +
    '<rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>' +
    '<line x1="6" x2="6.01" y1="6" y2="6"/>' +
    '<line x1="6" x2="6.01" y1="18" y2="18"/>',
  "server-cog":
    '<path d="m10.852 14.772-.383.923"/>' +
    '<path d="M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923"/>' +
    '<path d="m13.148 9.228.383-.923"/>' +
    '<path d="m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544"/>' +
    '<path d="m14.772 10.852.923-.383"/>' +
    '<path d="m14.772 13.148.923.383"/>' +
    '<path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5"/>' +
    '<path d="M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5"/>' +
    '<path d="M6 18h.01"/>' +
    '<path d="M6 6h.01"/>' +
    '<path d="m9.228 10.852-.923-.383"/>' +
    '<path d="m9.228 13.148-.923.383"/>',
  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  "shield-check":
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  "shield-half":
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' +
    '<path d="M12 22V2"/>',
  shuffle:
    '<path d="m18 14 4 4-4 4"/>' +
    '<path d="m18 2 4 4-4 4"/>' +
    '<path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/>' +
    '<path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/>' +
    '<path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  "sliders-horizontal":
    '<path d="M10 5H3"/>' +
    '<path d="M12 19H3"/>' +
    '<path d="M14 3v4"/>' +
    '<path d="M16 17v4"/>' +
    '<path d="M21 12h-9"/>' +
    '<path d="M21 19h-5"/>' +
    '<path d="M21 5h-7"/>' +
    '<path d="M8 10v4"/>' +
    '<path d="M8 12H3"/>',
  "smile-plus":
    '<path d="M13.267 2.08a10 10 0 108.653 8.653"/>' +
    '<path d="M15 10V9"/>' +
    '<path d="M16 5h6"/>' +
    '<path d="M16.472 15a6 6 0 01-8.943 0"/>' +
    '<path d="M19 2v6"/>' +
    '<path d="M9 10V9"/>',
  "sticky-note":
    '<path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/>' +
    '<path d="M15 3v5a1 1 0 0 0 1 1h5"/>',
  tag:
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>' +
    '<circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  ticket:
    '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>' +
    '<path d="M13 5v2"/>' +
    '<path d="M13 17v2"/>' +
    '<path d="M13 11v2"/>',
  "trash-2":
    '<path d="M10 11v6"/>' +
    '<path d="M14 11v6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M3 6h18"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/>' +
    '<path d="M12 17h.01"/>',
  trophy:
    '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/>' +
    '<path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/>' +
    '<path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/>' +
    '<path d="M4 22h16"/>' +
    '<path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/>' +
    '<path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
  user:
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/>',
  "user-cog":
    '<path d="M10 15H6a4 4 0 0 0-4 4v2"/>' +
    '<path d="m14.305 16.53.923-.382"/>' +
    '<path d="m15.228 13.852-.923-.383"/>' +
    '<path d="m16.852 12.228-.383-.923"/>' +
    '<path d="m16.852 17.772-.383.924"/>' +
    '<path d="m19.148 12.228.383-.923"/>' +
    '<path d="m19.53 18.696-.382-.924"/>' +
    '<path d="m20.772 13.852.924-.383"/>' +
    '<path d="m20.772 16.148.924.383"/>' +
    '<circle cx="18" cy="15" r="3"/>' +
    '<circle cx="9" cy="7" r="4"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
    '<path d="M16 3.128a4 4 0 0 1 0 7.744"/>' +
    '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
    '<circle cx="9" cy="7" r="4"/>',
  "volume-2":
    '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>' +
    '<path d="M16 9a5 5 0 0 1 0 6"/>' +
    '<path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
  vote:
    '<path d="m9 12 2 2 4-4"/>' +
    '<path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z"/>' +
    '<path d="M22 19H2"/>',
  "wand-sparkles":
    '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/>' +
    '<path d="m14 7 3 3"/>' +
    '<path d="M5 6v4"/>' +
    '<path d="M19 14v4"/>' +
    '<path d="M10 2v2"/>' +
    '<path d="M7 8H3"/>' +
    '<path d="M21 16h-4"/>' +
    '<path d="M11 3H9"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
  zap: '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>',
} as const;

export type IconName = keyof typeof ICONS;

export interface IconOptions {
  /** Draw at 20px (`kb-icon--lg`) instead of 16px. */
  large?: boolean;
  /** Extra class names, such as `kb-chev`. Fixed strings from code, escaped anyway. */
  className?: string;
  /**
   * Accessible name. Leave it out when the text beside the icon already says
   * the same thing, which is the usual case: the icon is then hidden from
   * assistive technology. Pass it only when the icon stands alone and means
   * something. Colour never carries the meaning by itself.
   */
  label?: string;
}

/** The inline `<svg>` for `name`. */
export function icon(name: IconName, opts: IconOptions = {}): string {
  const cls = ["kb-icon"];
  if (opts.large) cls.push("kb-icon--lg");
  if (opts.className) cls.push(opts.className);
  const a11y = opts.label
    ? `role="img" aria-label="${escapeHtml(opts.label)}"`
    : 'aria-hidden="true"';
  return `<svg class="${escapeHtml(cls.join(" "))}" viewBox="0 0 24 24" ${a11y} focusable="false">${ICONS[name]}</svg>`;
}

/** Callout and issue tones; the empty string is the plain (info) callout. */
export type Tone = "" | "ok" | "warn" | "err";

const TONE_ICONS: Record<Tone, IconName> = {
  "": "info",
  ok: "circle-check",
  warn: "triangle-alert",
  err: "circle-x",
};

/**
 * The icon a callout or issue row carries for its tone. The title and text
 * say the same thing in words, so the icon is decorative (`aria-hidden`):
 * colour and shape back the words up, they never replace them.
 */
export function toneIcon(tone: Tone, opts: IconOptions = {}): string {
  return icon(TONE_ICONS[tone], opts);
}
