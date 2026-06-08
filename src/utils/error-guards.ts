/**
 * Runtime type guards for narrowing `unknown` errors caught from external APIs.
 *
 * Prefer these over blind `as { ... }` casts: a cast trusts the compiler shape
 * but does no runtime validation, so missing properties read as `undefined`
 * and silently break logic that depends on them (e.g. rate-limit retry).
 */

export function isErrorWithMessage(e: unknown): e is { message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  );
}

export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (isErrorWithMessage(e)) return e.message;
  return String(e);
}
