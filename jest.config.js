/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  resolver: '<rootDir>/jest.resolver.cjs',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts',
  ],
  // Exclusions are deliberate (#848): `index.ts` is process wiring (env validation,
  // service construction, event routing, graceful shutdown) that is exercised by
  // running the bot rather than by unit tests, and `src/scripts/**` are one-shot
  // operational entry points. Together they are ~5% of source; including `index.ts`
  // at 0% would move the global figure by ~1.4 points.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/loader.js',
    '!src/unregister-guild-commands.ts',
    '!src/scripts/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  // Floors sit a few points under measured coverage so a real regression fails the
  // build. Measured at the time of writing: 75.60% statements, 68.14% branches,
  // 80.62% functions, 76.01% lines -- raised here because the tracking opt-out
  // tests (#918) pushed actual line coverage past the drift budget below.
  //
  // Do not hand-ratchet these on a schedule -- that is what let them drift ~33
  // points out of date (#848). `npm run coverage:drift` (wired into CI) fails once
  // actual coverage climbs more than 10 points above any floor, which is the signal
  // to raise the numbers below to just under the new actuals.
  coverageThreshold: {
    global: {
      branches: 66,
      functions: 78,
      lines: 73,
      statements: 73,
    },
  },
  testTimeout: 10000,
  verbose: true,
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
};
