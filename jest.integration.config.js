import base from './jest.config.js';

/**
 * Real-MongoDB integration project (#1106).
 *
 * Deliberately separate from `jest.config.js`: no global mongoose mock
 * (`__tests__/setup.ts` is not loaded), no coverage collection and no
 * `coverageThreshold`, so these tests can never move the unit-test floors that
 * `npm run coverage:drift` checks. Run with `npm run test:integration`; the
 * suites skip themselves unless `MONGODB_URI` is set.
 *
 * @type {import('jest').Config}
 */
export default {
  preset: base.preset,
  testEnvironment: base.testEnvironment,
  extensionsToTreatAsEsm: base.extensionsToTreatAsEsm,
  resolver: base.resolver,
  transform: base.transform,
  rootDir: '.',
  roots: ['<rootDir>/__tests__/integration'],
  testMatch: ['**/*.integration.test.ts'],
  setupFiles: ['<rootDir>/__tests__/integration/env-setup.ts'],
  // Real server round-trips, plus index builds on first use.
  testTimeout: 30000,
  verbose: true,
};
