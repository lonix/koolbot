# Contributing to KoolBot

Thank you for your interest in contributing to KoolBot! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Community](#community)

## Getting Started

### Prerequisites

- **Node.js** 20 or higher
- **npm** (comes with Node.js)
- **Docker** and **Docker Compose** (for containerized development)
- **Git** for version control
- **Discord Bot Token** (for testing)
- **MongoDB** (local installation or Docker)

### First Time Setup

1. **Fork the repository** on GitHub

2. **Clone your fork** locally:

   ```bash
   git clone https://github.com/YOUR_USERNAME/koolbot.git
   cd koolbot
   ```

3. **Add upstream remote**:

   ```bash
   git remote add upstream https://github.com/lonix/koolbot.git
   ```

4. **Install dependencies**:

   ```bash
   npm install
   ```

5. **Create your `.env` file**:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your Discord bot credentials and MongoDB URI.

6. **Build the project**:

   ```bash
   npm run build
   ```

7. **Run tests** to ensure everything works:

   ```bash
   npm test
   ```

## Development Setup

### Local Development (Without Docker)

1. **Start MongoDB** (if not using Docker):

   ```bash
   # Using Docker for MongoDB only
   docker run -d -p 27017:27017 --name mongodb mongo:latest
   
   # Or use your local MongoDB installation
   ```

2. **Run in development mode** (with hot reload):

   ```bash
   npm run dev
   ```

### Docker Development

Use the development Docker Compose configuration:

```bash
# Start in development mode with hot reloading
docker-compose -f docker-compose.dev.yml up

# Run in detached mode
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f bot

# Stop containers
docker-compose -f docker-compose.dev.yml down
```

### Available Scripts

```bash
# Development
npm run dev              # Run with hot reload
npm run watch            # Watch mode for TypeScript compilation

# Building
npm run build            # Compile TypeScript

# Testing
npm test                 # Run all tests
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
npm run test:ci          # Run tests in CI mode

# Code Quality
npm run lint             # Check code quality with ESLint
npm run lint:fix         # Auto-fix linting issues
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
npm run check            # Run build + lint + format check
npm run check:all        # Run all checks including tests

# Utilities
npm run validate-config  # Validate configuration schema
npm run migrate-config   # Migrate old configuration
npm run cleanup-global-commands  # Clean up Discord commands
```

## Development Workflow

### Branch Strategy

1. **Create a feature branch** from `main`:

   ```bash
   git checkout main
   git pull upstream main
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** in small, focused commits

3. **Keep your branch updated**:

   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

4. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request** on GitHub

### Types of Contributions

- **🐛 Bug Fixes** - Fix issues or incorrect behavior
- **✨ Features** - Add new functionality
- **📚 Documentation** - Improve or add documentation
- **🧪 Tests** - Add or improve tests
- **♻️ Refactoring** - Code improvements without changing functionality
- **🎨 Style** - Code formatting and style improvements
- **⚡ Performance** - Performance improvements
- **🔧 Tooling** - Build tools, CI/CD, development environment

## Coding Standards

### TypeScript Guidelines

- **Use explicit types** - Avoid `any` where possible
- **Follow existing patterns** - Maintain consistency with the codebase
- **Use meaningful names** - Variables, functions, and classes should be descriptive
- **Keep functions focused** - Each function should do one thing well
- **Add JSDoc comments** for complex logic or public APIs

### Code Style

We use **ESLint** and **Prettier** to enforce code style:

```bash
# Check for linting issues
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Check formatting
npm run format:check

# Auto-format code
npm run format
```

**Key conventions:**

- **Indentation**: 2 spaces
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Line length**: Max 120 characters (enforced by Prettier)
- **Trailing commas**: Required in multi-line objects/arrays

### Architecture Patterns

Follow the established architecture:

1. **Services** (`src/services/`) - Business logic and core functionality
   - Use singleton pattern with `getInstance()`
   - Handle initialization and cleanup
   - Emit events for important state changes

2. **Commands** (`src/commands/`) - Discord slash commands
   - Export `data` (SlashCommandBuilder) and `execute` function
   - Handle errors gracefully with user-friendly messages
   - Use `interaction.deferReply()` for long-running operations

3. **Models** (`src/models/`) - MongoDB schemas
   - Define clear TypeScript interfaces
   - Use Mongoose schemas for validation
   - Export both interface and model

4. **Utils** (`src/utils/`) - Helper functions
   - Pure functions when possible
   - Well-documented and tested
   - Reusable across the codebase

### Configuration

- **All new features must be toggleable** via configuration
- Add configuration schema in `src/services/config-schema.ts`
- Use dot notation for keys (e.g., `feature.subfeature.enabled`)
- Document new config keys in `SETTINGS.md`
- Use `ConfigService` for all configuration access

### Error Handling

- **Never crash the bot** - Catch and log errors appropriately
- **Use try-catch blocks** for async operations
- **Log errors** with context using the logger utility
- **Return user-friendly error messages** in Discord interactions
- **Recover gracefully** when possible

## Testing Guidelines

### Writing Tests

- **Write tests for all new features** and bug fixes
- **Follow the AAA pattern**: Arrange, Act, Assert
- **Use descriptive test names**: `it('should do something specific when condition')`
- **Mock external dependencies**: Discord.js, MongoDB, file system, network calls
- **Test edge cases** and error conditions

### Test Structure

```typescript
import { describe, it, expect } from '@jest/globals';

describe('MyService', () => {
  describe('myMethod', () => {
    it('should return expected value when given valid input', () => {
      // Arrange
      const input = 'test';
      const service = new MyService();
      
      // Act
      const result = service.myMethod(input);
      
      // Assert
      expect(result).toBe('expected');
    });

    it('should throw error when given invalid input', () => {
      // Arrange
      const invalidInput = null;
      const service = new MyService();
      
      // Act & Assert
      expect(() => service.myMethod(invalidInput)).toThrow('Invalid input');
    });
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (recommended during development)
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- path/to/test.test.ts
```

### Test Coverage

- **Minimum coverage**: 2% (current baseline)
- **Target coverage**: 70-80% for critical modules
- **Focus on**: Commands, services, utilities
- **Coverage reports** are generated in `coverage/` directory

## Commit Guidelines

### Commit Message Format

We use **conventional commits** format:

```text
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Build process, tooling, dependencies
- `perf`: Performance improvements
- `ci`: CI/CD changes

**Examples:**

```bash
feat(commands): add quote search functionality

Add ability to search quotes by keyword using /quote search command.
Includes fuzzy matching and pagination for results.

Closes #123

---

fix(voice): prevent memory leak in voice channel cleanup

Voice channels were not being properly cleaned up due to missing
event listener removal. Added cleanup in the disconnect handler.

Fixes #456

---

docs: update CONTRIBUTING.md with testing guidelines

Add detailed section on writing tests and test coverage expectations.
```

### Commit Best Practices

- **Make atomic commits** - Each commit should represent one logical change
- **Write clear messages** - Explain what and why, not how
- **Reference issues** - Use `Closes #123`, `Fixes #456`, or `Refs #789`
- **Keep commits focused** - Don't mix refactoring with bug fixes

## Pull Request Process

### Before Submitting

1. **Run all quality checks**:

   ```bash
   npm run check:all
   ```

2. **Ensure tests pass**:

   ```bash
   npm test
   ```

3. **Verify markdown** (if documentation changed):

   ```bash
   npx markdownlint "**/*.md" --ignore node_modules --ignore dist
   ```

4. **Update documentation** if needed:
   - `COMMANDS.md` for new commands
   - `SETTINGS.md` for new configuration options
   - `README.md` for user-facing features
   - Add comments for complex logic

5. **Update Dockerfiles** if dependencies changed

### Pull Request Template

When you open a PR, the template will guide you through the required information:

- **Description**: What does this PR do?
- **Type of Change**: Bug fix, feature, documentation, etc.
- **Testing**: How was this tested?
- **Checklist**: Code quality, tests, documentation
- **Related Issues**: Link to relevant issues

### Review Process

1. **Automated checks** will run:
   - TypeScript compilation
   - ESLint checks
   - Prettier formatting
   - Jest tests with coverage
   - Markdown linting (for doc changes)
   - Docker build validation

2. **Code review** by maintainers:
   - Code quality and adherence to standards
   - Test coverage and quality
   - Documentation completeness
   - Security considerations

3. **Address feedback**:
   - Make requested changes
   - Push updates to your branch
   - Respond to review comments

4. **Merge**:
   - Maintainers will merge approved PRs
   - Your contribution will be included in the next release
   - PR will be automatically labeled for release notes

### PR Labels

Your PR will be automatically labeled based on file changes:

- `documentation` - Markdown file changes
- `dependencies` - package.json changes
- `github-actions` - Workflow changes
- `test` - Test file changes
- `docker` - Dockerfile changes

You can also add manual labels:

- `feature`/`enhancement` - New features
- `bug`/`fix` - Bug fixes
- `breaking` - Breaking changes
- `patch` - Patch release changes

## Issue Reporting

### Before Creating an Issue

1. **Search existing issues** - Your issue may already be reported
2. **Check documentation** - The answer might be in the docs
3. **Try latest version** - The issue may already be fixed

### Creating an Issue

Use the appropriate issue template:

- **🐛 Bug Report** - Report a bug or unexpected behavior
- **✨ Feature Request** - Suggest a new feature or enhancement
- **📚 Documentation** - Request documentation improvements
- **❓ Question** - Ask questions (or use Discussions)

### Good Issue Reports Include

- **Clear title** - Summarize the issue in one line
- **Description** - Detailed explanation of the issue
- **Steps to reproduce** - For bugs, exact steps to reproduce
- **Expected behavior** - What you expected to happen
- **Actual behavior** - What actually happened
- **Environment** - OS, Node version, Docker version
- **Logs** - Relevant error messages or logs
- **Screenshots** - For UI issues

## Community

### Getting Help

- **GitHub Issues** - Bug reports and feature requests
- **GitHub Discussions** - Questions, ideas, and general discussion
- **Pull Requests** - Code contributions

### Communication Guidelines

- **Be respectful** - Treat everyone with respect and empathy
- **Be constructive** - Provide helpful feedback and suggestions
- **Be patient** - Maintainers are volunteers with limited time
- **Be clear** - Provide sufficient context and information
- **Stay on topic** - Keep discussions focused and relevant

### Recognition

Contributors are recognized in:

- **Release notes** - Automatic attribution in release changelogs
- **GitHub insights** - Contributor graphs and statistics
- **Pull request comments** - Public acknowledgment and thanks

## Questions?

If you have questions about contributing, please:

1. Check this guide thoroughly
2. Search existing issues and discussions
3. Open a new discussion on GitHub
4. Tag your question appropriately

Thank you for contributing to KoolBot! 🚀
