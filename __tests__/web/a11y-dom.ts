/**
 * Installs a served HTML document into the jsdom global document so axe can
 * scan it (issue #856). Shared by `a11y-axe.test.ts` and `a11y-routes.test.ts`.
 *
 * The page is parsed with the browser's own HTML parser rather than by
 * stripping the `<!doctype>` / `<html>` wrapper with regexes: a regex that
 * tries to recognise tags is both wrong on edge cases and exactly the shape
 * CodeQL flags as a bad tag filter. `DOMParser` handles the wrapper, the
 * `lang` attribute and the head/body split correctly and for free.
 *
 * Inline `<script>` elements are dropped. jsdom would otherwise execute the
 * layout's countdown / cascade scripts against a document with no real event
 * loop behind it, and they are not what the accessibility gate measures.
 */
export function installDocumentForAxe(html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const script of Array.from(parsed.querySelectorAll("script"))) {
    script.remove();
  }

  // `lang` and friends live on <html>, which is not part of head/body — copy
  // them across so `html-has-lang` gates the real attribute rather than
  // passing (or failing) on whatever the previous test left behind.
  for (const attr of Array.from(document.documentElement.attributes)) {
    document.documentElement.removeAttribute(attr.name);
  }
  for (const attr of Array.from(parsed.documentElement.attributes)) {
    document.documentElement.setAttribute(attr.name, attr.value);
  }

  document.documentElement.replaceChildren(
    document.importNode(parsed.head, true),
    document.importNode(parsed.body, true),
  );
}
