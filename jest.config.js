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
  // build. Measured at the time of writing: 68.58% statements, 62.64% branches,
  // 74.41% functions, 68.77% lines -- raised here because the admin write-surface
  // route tests (#849) pushed actual coverage past the drift budget below.
  //
  // Do not hand-ratchet these on a schedule -- that is what let them drift ~33
  // points out of date (#848). `npm run coverage:drift` (wired into CI) fails once
  // actual coverage climbs more than 10 points above any floor, which is the signal
  // to raise the numbers below to just under the new actuals.
  coverageThreshold: {
    global: {
      branches: 78,
      functions: 84,
      lines: 85,
      statements: 84,
    },
  },
  testTimeout: 10000,
  // Recycle a Jest worker once its heap passes 3 GB after a suite (#1501). With coverage on, a
  // worker's heap runs at about 2.6-2.8 GB (median) and peaks near 3.9 GB over the full run, against
  // a V8 heap limit of about 4.1-4.3 GB on Node 22, 24 and 26; whichever suite lands next to a worker
  // at its peak is reported as "Jest worker ran out of memory". Recycling bounds the heap well under
  // that limit on every Node version. Measured with `--logHeapUsage` (the same heapUsed figure).
  workerIdleMemoryLimit: '3GB',
  verbose: true,
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  // Real-MongoDB suites (#1106) run under jest.integration.config.js, not here: this
  // project mocks mongoose globally and must stay fast and database-free.
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
};
