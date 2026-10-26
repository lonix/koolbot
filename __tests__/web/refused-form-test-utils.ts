/**
 * Shared checks for a refused form (#1517, #1520): the route answers 422 with
 * the page drawn again. Pure parsing of the response text; imports nothing
 * from `src/`, so a suite's `jest.unstable_mockModule` calls still apply.
 */

import { expect } from "@jest/globals";

export interface Refusal {
  html: string;
  /** Element ids of the controls marked `aria-invalid="true"`, in page order. */
  invalidIds: string[];
  /** Error line text by the line's id. */
  errorLines: Record<string, string>;
}

/** Assert a refusal (422 with the page) and read what it marks and says. */
export async function refusal(res: Response): Promise<Refusal> {
  expect(res.status).toBe(422);
  const html = await res.text();
  const invalidIds = [...html.matchAll(/<[^>]*aria-invalid="true"[^>]*>/g)].map(
    (m) => /id="([^"]+)"/.exec(m[0])?.[1] ?? "",
  );
  const errorLines: Record<string, string> = {};
  for (const m of html.matchAll(
    /<p class="kb-field__error" id="([^"]+)">([^<]*)<\/p>/g,
  )) {
    errorLines[m[1]] = m[2];
  }
  return { html, invalidIds, errorLines };
}
