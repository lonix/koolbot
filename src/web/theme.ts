/**
 * Shared dark-theme colour tokens for the WebUI.
 *
 * Both the authenticated admin layout (`admin-layout.ts`) and the small
 * pre-auth pages (`views.ts`) draw their core palette from here so the
 * sign-in / sign-out / invalid-link pages stay visually consistent with
 * the rest of the dark admin UI instead of drifting toward a stray light
 * theme (issue #569).
 */
export const THEME = {
  /** Page background. */
  bg: "#0f1115",
  /** Primary body text. */
  text: "#e4e6eb",
  /** Links. */
  link: "#6ea8fe",
  /** Raised surfaces (cards, side nav, code). */
  surface: "#161a22",
  /** Table-header / hover surface. */
  surfaceAlt: "#1a1f2a",
  /** Hairline borders / dividers (decorative — cards, table rows). */
  border: "#2d3748",
  /**
   * Border of form controls (input / select / textarea). Unlike `border`,
   * this one is a UI-component boundary and must reach 3:1 against the
   * control's `bg` fill and the surrounding `surface` (WCAG 1.4.11, #855):
   * #64748b is 3.97:1 on `bg` and 3.66:1 on `surface`.
   */
  control: "#64748b",
  /** Keyboard focus ring (WCAG 2.4.7, #855) — 10.5:1 on `bg`, 9.7:1 on `surface`. */
  focus: "#93c5fd",
  /** Secondary / muted text — 7.4:1 on `bg`, 6.8:1 on `surface`. */
  muted: "#94a3b8",
  /** Inline warning text — 8.1:1 on `surface`. */
  warn: "#f59e0b",
  /** Destructive action button — white text reaches 4.8:1 (#ef4444 only managed 3.8:1). */
  danger: "#dc2626",
  /** Destructive action button (hover). */
  dangerHover: "#b91c1c",
  /** Primary action button. */
  primary: "#2563eb",
  /** Primary action button (hover). */
  primaryHover: "#1d4ed8",
  /** Text on the primary button. */
  onPrimary: "#fff",
} as const;
