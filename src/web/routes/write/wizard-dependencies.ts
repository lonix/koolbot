/**
 * Feature-dependency check for the Setup wizard's Review and Apply (#1622).
 *
 * Review and Apply must judge the same batch, so both call this: the settings
 * the admin chose, plus the `false` gates Apply adds for every feature that was
 * not ticked. It reports which dependents would have to go off with a feature
 * that is being turned off (the admin confirms them on Review), and what is
 * still refused after that (#663 stays: nothing is switched off silently).
 */
import {
  dependencyGraphKeys,
  planDisableCascade,
  validateDependencies,
  type ConfigSchema,
  type DependencyCascade,
  type DependencyIssue,
} from "../../../services/config-schema.js";
import { wizardOffGates } from "./helpers.js";

export interface WizardDependencyPlan {
  /** Per feature being turned off: the dependents that are on and must go off with it. */
  cascade: DependencyCascade[];
  /** The union of those dependents, sorted: what a confirmed Apply also turns off. */
  cascadeKeys: string[];
  /** What the admin confirms by posting this back; Apply recomputes it and compares. */
  fingerprint: string;
  /** Still refused once the cascade is applied (an enable whose requirement stays off). */
  blockers: DependencyIssue[];
}

export async function planWizardDependencies(
  configuration: Record<string, unknown>,
  selectedFeatures: readonly string[],
  getBoolean: (key: string) => Promise<boolean>,
): Promise<WizardDependencyPlan> {
  const batch: Record<string, unknown> = { ...configuration };
  for (const gate of wizardOffGates(selectedFeatures)) batch[gate] = false;

  const live = new Map<string, boolean>();
  for (const key of dependencyGraphKeys()) {
    live.set(key, await getBoolean(key));
  }
  const resolve = (key: keyof ConfigSchema): boolean => live.get(key) ?? false;

  const { cascade, keys } = planDisableCascade(batch, resolve);
  const settled: Record<string, unknown> = { ...batch };
  for (const key of keys) settled[key] = false;
  return {
    cascade,
    cascadeKeys: keys,
    fingerprint: keys.join(","),
    blockers: validateDependencies(settled, resolve),
  };
}
