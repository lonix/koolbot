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
├── services/       # Tests for business logic services
└── utils/          # Tests for utility functions
```

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

Current Coverage Thresholds:

- Statements: 2%
- Branches: 2%
- Functions: 2%
- Lines: 2%

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

Tests are automatically run in GitHub Actions CI. See `.github/workflows/test.yml` for configuration.

## Future Improvements

- [ ] Add integration tests for Discord interactions
- [ ] Add end-to-end tests for voice channel management
- [ ] Increase coverage to >70% for critical paths
- [ ] Add snapshot testing for command outputs
- [ ] Add performance benchmarks
