/**
 * Whether the end-of-year Rewind nudge DM is on. One rule for the nudge job
 * and for `/me/notifications`, which offers the toggle only while the DM can
 * be sent.
 *
 * Keys off the dedicated `rewind.nudge.enabled` toggle (#608), falling back
 * to the legacy `rewind.enabled` value for installs that opted into the nudge
 * before the key was split into feature (page) vs nudge. Passing the legacy
 * value as the default means an explicitly stored `rewind.nudge.enabled`
 * always wins, while installs that never set it inherit their old behaviour.
 *
 * `read` is `ConfigService.getBoolean` for a job that fails soft, or
 * `getBooleanStrict` for a caller that must not mistake a failed read for off.
 */
export type BooleanReader = (
  key: string,
  fallback: boolean,
) => Promise<boolean>;

export async function isRewindNudgeEnabled(
  read: BooleanReader,
): Promise<boolean> {
  const legacy = await read("rewind.enabled", false);
  return read("rewind.nudge.enabled", legacy);
}
