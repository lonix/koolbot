import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        // Add Node.js globals
        'process': 'readonly',
        'setInterval': 'readonly',
        'clearInterval': 'readonly',
        'setTimeout': 'readonly',
        'clearTimeout': 'readonly',
        '__dirname': 'readonly',
        '__filename': 'readonly',
        'console': 'readonly',
        'module': 'readonly',
        'require': 'readonly',
        'global': 'readonly',
        'Buffer': 'readonly',
        // Web platform globals available in Node.js 22+
        'fetch': 'readonly',
        'Request': 'readonly',
        'Response': 'readonly',
        'Headers': 'readonly',
        'AbortController': 'readonly',
        'AbortSignal': 'readonly',
        'ReadableStream': 'readonly',
        'TextEncoder': 'readonly',
        'TextDecoder': 'readonly',
        'DOMException': 'readonly',
        'URL': 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'error',
      'no-console': 'off',
      'no-debugger': 'warn',
      'no-duplicate-imports': 'error',
      'no-unused-vars': 'off',
      'prefer-const': 'error'
    }
  },
  {
    // Test files lean heavily on Discord.js fixtures and partial mocks where
    // precise return-type annotations and fully-typed mock objects add noise
    // without catching real bugs. Production `src/` code above is still held
    // to the strict bar; `no-unused-vars` stays an error here so dead test
    // helpers are still caught. See issue #392.
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
