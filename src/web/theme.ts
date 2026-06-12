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
  /** Hairline borders / dividers. */
  border: "#2d3748",
  /** Primary action button. */
  primary: "#2563eb",
  /** Primary action button (hover). */
  primaryHover: "#1d4ed8",
  /** Text on the primary button. */
  onPrimary: "#fff",
} as const;
