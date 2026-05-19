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
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/loader.js',
    '!src/unregister-guild-commands.ts',
    '!src/scripts/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Incrementally raised from 2% baseline toward the stated 70-80% goal.
  // Current achieved coverage: ~23% statements/lines, ~36% functions, ~17% branches.
  // Raise these thresholds by ~10 percentage points each sprint.
  coverageThreshold: {
    global: {
      branches: 15,
      functions: 25,
      lines: 20,
      statements: 20,
    },
  },
  testTimeout: 10000,
  verbose: true,
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
};
