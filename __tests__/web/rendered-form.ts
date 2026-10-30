/* global HTMLFormElement, HTMLInputElement, HTMLSelectElement */
/**
 * Posts a form as a browser without JavaScript would: the page's own markup is
 * parsed, an optional edit stands for what the person did (type, pick, tick),
 * and the controls are serialised with the platform's `FormData`, which leaves
 * out unticked boxes and disabled controls. Nothing here runs a page script.
 */
import { JSDOM } from "jsdom";

export type PostedBody = Record<string, string | string[]>;

export function renderedFormBody(
  html: string,
  actionEnd: string,
  edit: (form: HTMLFormElement) => void = () => undefined,
): PostedBody {
  const { window } = new JSDOM(html);
  const form = Array.from(window.document.querySelectorAll("form")).find((f) =>
    f.getAttribute("action")?.endsWith(actionEnd),
  );
  if (!form) throw new Error(`no form posting to ...${actionEnd}`);
  edit(form);
  const body: PostedBody = {};
  for (const [name, value] of new window.FormData(form).entries()) {
    if (name === "_csrf" || typeof value !== "string") continue;
    const had = body[name];
    body[name] =
      had === undefined
        ? value
        : Array.isArray(had)
          ? [...had, value]
          : [had, value];
  }
  return body;
}

/** What a person does to a rendered form: choose an option, type into a box. */
export function setField(
  form: HTMLFormElement,
  name: string,
  value: string,
  index = 0,
): void {
  const el = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    `[name="${name}"]`,
  )[index];
  if (!el) throw new Error(`no control ${name}[${index}]`);
  el.value = value;
}
