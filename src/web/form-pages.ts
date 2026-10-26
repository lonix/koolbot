/**
 * The pages a refused form is rendered on again (#1517).
 *
 * The admin pages load their data and render in the read-only router; the
 * write routers must not import that module (it pulls in most of the bot). A
 * page that takes part registers one renderer here, keyed by its path, and
 * `refuseForm` (`routes/write/helpers.ts`) calls it when a form is refused.
 * The renderer is the same function the page's GET handler uses, given the
 * {@link RefusedForm} to draw.
 */

import type { Request } from "express";
import type { RefusedForm } from "./form-errors.js";

export type FormPageRenderer = (
  req: Request,
  refused: RefusedForm,
) => Promise<string>;

const renderers = new Map<string, FormPageRenderer>();

/** Register (or replace) the renderer for a page, by its path ("/admin/polls"). */
export function registerFormPage(
  path: string,
  renderer: FormPageRenderer,
): void {
  renderers.set(path, renderer);
}

export function getFormPage(path: string): FormPageRenderer | undefined {
  return renderers.get(path);
}
