# Testing Guide

This project uses **Jest** as the testing framework with TypeScript support via `ts-jest`.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests in CI mode (for GitHub Actions)
npm run test:ci
```

## Test Structure

Tests are located in the `__tests__` directory, organized by module:

```plaintext
__tests__/
├── commands/       # Tests for Discord slash commands
├── config/         # Tests for env/config plumbing
├── content/        # Tests for the static content definitions
├── handlers/       # Tests for button/modal/select interaction handlers
├── models/         # Tests for Mongoose model modules
├── scripts/        # Tests for operational scripts (src/scripts/)
├── services/       # Tests for business logic services
├── utils/          # Tests for utility functions
├── web/            # Tests for the Express Web UI (routes, renderers, a11y)
├── setup.ts        # Global mocks (mongoose, ConfigService) — runs per suite
└── test-utils.ts   # Shared Discord client/interaction mock builders
```

Files that are not `*.test.ts` are helpers, not suites: `test-utils.ts`,
`web/admin-harness.ts` and `web/a11y-*.ts` are imported by tests and never
collected by Jest.

### Accessibility tests

`__tests__/web/` carries the Web UI accessibility gate (issue #856):

- `a11y-axe.test.ts` runs axe-core over every page renderer's output.
- `a11y-routes.test.ts` runs axe over pages served through the real router.
- `a11y-contrast.test.ts` computes WCAG contrast ratios for the `THEME`
  palette (4.5:1 for text, 3:1 for control borders and the focus ring).

The two axe suites need a DOM, so they opt into `__tests__/jsdom-node-env.cjs`
through a `@jest-environment` docblock — jsdom with Node's web globals
restored, since `discord.js` pulls in undici. Everything else stays on the
default `node` environment.

`jest-environment-jsdom` is pinned with `~` rather than `^` so it tracks the
same minor as `jest` itself. The environment depends on internal `@jest/*`
packages; letting it drift a minor ahead makes npm install a second, nested
copy of `@jest/environment`, `jest-util` and `jest-mock` beside the ones Jest
resolves, which is a subtle-breakage risk for no benefit. Bump it together
with `jest`.

**Adding a Web UI page? Add it to `__tests__/web/a11y-pages.ts`.** That module
is the list of pages the axe scan walks; a page missing from it is not gated.
See the [Accessibility section of `WEBUI.md`](WEBUI.md#accessibility) for the
conventions the scan enforces.

### Shared helpers

Prefer the shared builders over hand-rolling a stub — a large part of the
duplication across suites came from every file inventing its own Discord
mocks (issue #849).

- `__tests__/test-utils.ts` — `createMockClient`,
  `createMockChatInputInteraction`, `createMockButtonInteraction`,
  `createRawMember` (the string permission bitfield an uncached interaction
  member carries) and `createMockCollection`.
- `__tests__/web/admin-harness.ts` — mounts real Express routers on an
  ephemeral port and drives them with `fetch`. `startAdminHarness()` handles
  body encoding and the double-submit CSRF token; `createTestSession()` /
  `stubRequireSession()` stand in for the Mongo-backed session middleware,
  and `parseFlashRedirect()` unpacks a handler's 303 `Location` into its
  flash parts. See `__tests__/web/write-routes-*.test.ts` for the shape.

The harness deliberately imports nothing from `src/`: suites register their
service mocks with `jest.unstable_mockModule` and then `await import()` the
routers, so a static import in the harness would load them too early and
defeat the mocks.

### Generating sample data for manual testing

To exercise the data-heavy surfaces (Rewind, leaderboards, digests,
achievements, `/stats`, the WebUI stats pages) without waiting for real
activity, seed a **dev/test** database:

```bash
npm run build
npm run seed-sample-data -- --yes
# tidy up afterwards (removes only seeded rows):
npm run seed-sample-data -- --clean --yes
```

The seeder refuses to run without `--yes`, namespaces everything behind a
`seed-` id prefix, and is deterministic given a fixed `--seed`. See
[Operational Scripts](DEVELOPER_GUIDE.md#operational-scripts) for the full
option list and the Docker recipe. Its pure data-generation helpers are
covered by `__tests__/scripts/seed-sample-data.test.ts` (the global mongoose
mock keeps the DB out of the unit tests).

## Writing Tests

### Basic Test Template

```typescript
import { describe, it, expect } from '@jest/globals';
import { myFunction } from '../../src/utils/myFunction.js';

describe('MyFunction', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });
});
```

### Testing with Mocks

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock external dependencies
jest.mock('../../src/utils/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

describe('MyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should log errors', () => {
    // Your test here
  });
});
```

### Time-Based Tests

For tests involving timers or time-dependent logic:

```typescript
import { jest } from '@jest/globals';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('should handle cooldown', () => {
  // Set cooldown
  cooldownManager.setCooldown('user1', 'command1');
  
  // Advance time by 30 seconds
  jest.advanceTimersByTime(30000);
  
  // Verify behavior
  expect(cooldownManager.isOnCooldown('user1', 'command1', 60)).toBe(true);
});
```

## Coverage Reports

Coverage reports are generated in the `coverage/` directory:

- **coverage/lcov-report/index.html** - HTML report (open in browser)
- **coverage/lcov.info** - LCOV format (for CI tools)

Current coverage thresholds (`coverageThreshold.global` in `jest.config.js`):

| Metric | Floor |
| --- | ---: |
| Statements | 66% |
| Branches | 60% |
| Functions | 72% |
| Lines | 66% |

These floors sit a few points under measured coverage rather than at a token baseline, so a real
regression fails CI. They are not ratcheted on a schedule — `npm run coverage:drift` fails once actual
coverage climbs more than 10 points above any floor, which is the cue to raise them to just under the
new actuals. Run it after a coverage run:

```bash
npm run test:coverage
npm run coverage:drift
```

`src/index.ts` (process wiring) and `src/scripts/**` (operational one-shots) are deliberately excluded
from the measurement — see the comment in `jest.config.js`.

## Best Practices

1. **Follow AAA Pattern** - Arrange, Act, Assert

   ```typescript
   it('should format duration correctly', () => {
     // Arrange
     const durationMs = 5000;
     
     // Act
     const result = formatDuration(durationMs);
     
     // Assert
     expect(result).toBe('5 seconds');
   });
   ```

2. **Test one thing at a time** - Each test should verify a single behavior

3. **Use descriptive test names** - Test names should clearly describe what they test

   ```typescript
   it('should return false when user has no cooldown set', () => {
     // ...
   });
   ```

4. **Avoid testing implementation details** - Focus on behavior, not internals

5. **Mock external dependencies** - Discord.js, MongoDB, etc.

6. **Keep tests independent** - Tests should not depend on each other

7. **Use beforeEach/afterEach** - Reset state between tests

## Test Examples

### Utility Function Tests

See `__tests__/utils/time.test.ts` for examples of testing pure utility functions.

### Service Tests

See `__tests__/services/cooldown-manager.test.ts` for examples of testing stateful services.

### Command Tests

See `__tests__/commands/ping.test.ts` for examples of testing Discord commands.
Metadata assertions (`data.name`, option types) are not enough on their own —
cover `execute()` too; `__tests__/commands/quote-execute.test.ts` and
`__tests__/commands/event-execute.test.ts` show the pattern.

### Web UI route tests

See `__tests__/web/write-routes-gating.test.ts` for the middleware contract
(`requireSession` → admin-role check → `requireCsrf`) and any
`__tests__/web/write-routes-<domain>.test.ts` for a domain router driven over
HTTP through the admin harness.

## Troubleshooting

### ES Modules Issues

If you see errors about ES modules, ensure:

- Tests use `.js` extensions in imports
- `node --experimental-vm-modules` is used in test scripts (required for ES modules in Jest)

### Type Errors

If you see TypeScript errors:

- Check that types are imported from `@jest/globals`
- Verify `@types/jest` is installed

### Timeout Issues

For tests that take longer than 10 seconds:

```typescript
it('should handle long operation', async () => {
  // Test code
}, 30000); // 30 second timeout
```

## CI Integration

Tests run automatically in GitHub Actions on pull requests to `main` and pushes to `main`. The
configuration lives in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), alongside the `lint`
and `typecheck` jobs:

- The `test` job runs `npm run test:ci` on a Node 22 and Node 24 matrix (`fail-fast: false`, so both
  legs always report).
- The `coverage:drift` check and the `coverage-report` artifact upload only run on the Node 22 leg.
- `ci-success` aggregates `lint`, `typecheck` and `test`, and is the single required status check for
  branch protection — it fails if any job failed or was cancelled.

## Future Improvements

- [ ] Add integration tests for Discord interactions
- [ ] Add end-to-end tests for voice channel management
- [ ] Increase coverage to >70% for critical paths
- [ ] Replace the global mongoose mock with `mongodb-memory-server` so model
      validators, indexes, defaults and TTLs are actually exercised
- [ ] Add snapshot testing for command outputs
- [ ] Add performance benchmarks
